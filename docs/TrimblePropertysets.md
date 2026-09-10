# Trimble property sets — how the Power BI connector does it

Analysis of `_attic/…/TrimbleConnectPropertysets` (a Power Query M connector),
written before any TypeScript, so the implementation has something to be checked
against.

## The problem it solves

Trimble Connect lets a user define **property sets inside Trimble** — libraries
of typed properties attached to model entities after import. Those values live
only in Trimble; they are never written back into the IFC. So the Model API,
which is all `src/routes/trimble.ts` currently uses, cannot see them.

Two extra APIs hold that data:

| API | Base (europe) | Role |
|-----|---------------|------|
| Organizer | `https://org-api.eu-west-1.connect.trimble.com/v1/` | Discovery: which property-set libraries is this project using? |
| Property Set | `https://pset-api.eu-west-1.connect.trimble.com/v1/` | The definitions (schema) and the values (per entity) |

## The pipeline, end to end

### 1. Discovery — which libraries does this project use?

`Organizer.pqm:8` `GetProjectLibraryIds`:

```
GET {Organizer}/forests/project:{projectId}:data/trees/ProjectContext/nodes/PSetLibs
```

The Organizer models a project as a *forest* of *trees* of *nodes*. Trimble
stores the project's property-set library bindings at the well-known path
`ProjectContext` → `PSetLibs`. The response's `links` array holds library
references as `frn:` URNs; each is stripped to a bare id.

A **404 is not an error** — it means the project has no property-set libraries,
and the connector returns `{}` and skips the whole feature (`Core.pqm:66`
records this as `checks["PropertySet API"] = false`).

### 2. Definitions — the schema

`Propertyset.pqm:32` `GetPSetLibDefs`, per library id:

```
GET {Propertyset}/libs/{libId}/defs        (paged, 200/page)
```

Each definition yields, per property:

| Field | Source in the response |
|-------|------------------------|
| `libId`, `defId`, `v` | `[libId]`, `[id]`, `[v]` |
| property-set name | `i18n["en-US"].name` |
| property **key** | a field name of `schema.props` |
| property **display name** | `i18n["en-US"].props[<key>]` |
| type | `schema.props[<key>].type` |
| description, enum | optional |

The key insight: **`schema.props` is keyed by an opaque property id, and the
human-readable name lives in a parallel `i18n` record.** The value payload in
step 3 is keyed by the same opaque ids, so the definitions are the only way to
turn values into named columns.

Duplicate display names are disambiguated by appending the property-set name
(`Propertyset.pqm:61-78`, then again as a group-by pass at `:103-134` — belt and
braces, and the second pass is the one that actually holds).

### 3. Values — per entity

`Propertyset.pqm:138` `GetTrimblePsets`, per distinct `(libId, defId)`:

```
GET {Propertyset}/libs/{libId}/defs/{defId}/psets       (paged, 200/page)
```

Each item has a `props` record (keyed by the opaque property id) and a `link`
field: the entity this property set is attached to, again as an `frn:` URN.

Then: expand `props` into columns, rename opaque ids to display names using the
definitions from step 2, and normalise the column names.

### 4. The join — where "no visible difference" comes from

`Helpers.pqm:191-198`:

```
Table.Join(model_API, "GUID", psetEntities, "Link", JoinKind.LeftOuter)
```

- `GUID` is the Model API entity's `id` (`Helpers.pqm:154-160`).
- `Link` is the pset item's `link` after `RemoveFrnPrefix`.

`RemoveFrnPrefix` (`Helpers.pqm:220`) splits on `:`, drops the first two
segments, rejoins: `frn:tccs:<entityId>` → `<entityId>`. So a **left outer join
on entity id** is the whole trick. Trimble properties become extra columns on
the same row as the IFC properties, and downstream nothing can tell them apart.

That is exactly the property we want: identical shape, merged at the entity, with
IFC entities that have no Trimble properties simply carrying nulls.

## Name normalisation

`NormalizeName` (`Helpers.pqm:230`): `Text.Proper(Text.Trim(Text.TrimStart(name, "-")))`
— strip leading hyphens, trim, then Title Case. Applied to both IFC-derived and
Trimble-derived column names, which is a second reason the two become
indistinguishable downstream.

Type coercion (`GenerateSchema`, `Helpers.pqm:323`) maps the declared type
loosely: anything containing `integer` → int; `number|mass|leng|area|volume|angl`
→ float; `bool` → boolean; `string` → text; otherwise untyped.

## Pagination

`Pagination.pqm:3` `FetchPages`: `?top={pageSize}&offset={offset}`, and the
response may carry `offsetNext`, `total`, and/or `next` (an absolute URL). The
loop prefers `next` when present, else re-derives offset; it stops when a page
returns fewer than `pageSize` rows or offset reaches total.

Note this is a **different pagination dialect** from the Produuzit
`limit`/`offset`/`results`/`next` shape in `produuzit-client.ts`, and different
again from what `fetchAllTrimblePages` currently assumes (`top`/`offset`, stop on
short page, no `next` handling).

## What this means for ModelBridge

**The OAuth scope is already correct.** `Configuration.json:36` requests
`openid Datatable_extractor` — byte-identical to our `TRIMBLE_SCOPE` default.
The existing Trimble connection can call both new APIs with no re-consent.

**`REGION_ENDPOINTS` needs a `Propertyset` entry.** `trimble-client.ts:118`
currently has Core, Model and Organizer but no pset host. The europe value is
`https://pset-api.eu-west-1.connect.trimble.com/v1/`.

**The merge point is `transformEntityPsets`.** `trimble.ts:251` already converts
Trimble's positional `psets` array into a `{PsetName: {PropName: value}}` object.
Trimble-defined property sets should be folded into that same object, keyed by
the entity id, before the result is returned — then `extractProp`, the column
mapper, and every import path downstream work unchanged, with no notion that a
property came from anywhere unusual.

## The FRN handling, and why it is not a straight port

An FRN is URN-shaped and its resource tail is percent-encoded. The connector
handles this in exactly one place — `RemoveFrnPrefix` (`Helpers.pqm:220`):
split on `:`, drop two segments, rejoin with `:`. **It never decodes.**
`DecodeUrl` exists in the same file but is applied only to `treeName` and
`nodeName` (`Organizer.pqm:49,67`); it never touches a link. So a link carrying
any encoded character keeps it, and the join compares `%3A` against a raw id.

That leaves two things genuinely unresolved from source alone:

- **Arity.** `RemoveFrnPrefix` rejoins the tail with colons, implying its author
  expected a multi-segment tail. Yet `Organizer.pqm:19` feeds a stripped library
  link straight into `/libs/{libId}/defs`, a URL that evidently works — which
  only holds if *that* tail is a bare id. Library and entity FRNs may simply
  differ in arity.
- **Encoding.** Whether entity ids in practice contain characters that get
  percent-encoded. IFC GlobalIds (base64: `0-9A-Za-z_$`) would not; other
  Trimble id forms might.

Rather than pick a reading, `src/trimble-frn.ts` parses an FRN into every
plausible key — the bare trailing segment, the full decoded tail, and the
undecoded forms — and the merge tries them in order. Both readings are covered
by tests, and `safeDecode` is applied throughout.

**The important part is the diagnostic.** A wrong guess here does not fail; as a
left outer join it looks exactly like "this project has no Trimble properties".
So `mergeTrimblePsets` counts matches and, when values exist but nothing matched,
returns a note plus sample keys from both sides. That surfaces in the UI as a
warning toast instead of a column of nulls.

## Open questions still to settle against the live API

1. **Trailing slashes.** `RegionStatic` bases end in `/`, and `Organizer.pqm:11`
   concatenates `"/forests/…"` producing `//forests/`, while `:89` concatenates
   `"forests/"` without. Inconsistent in the same file. Our `joinUrl` normalises
   to a single slash either way.
2. **Whether the pset API honours `top`/`offset` or only `next`.** We reuse
   `fetchAllTrimblePages`, which sends `top`/`offset` and stops on a short page.
3. **Whether one entity can carry the same `defId` twice** (repeatable property
   sets). The connector assumes one row per entity per def; our merge accumulates
   instead, so a second row adds properties rather than being dropped — but if
   the same property appears twice, last write wins.
