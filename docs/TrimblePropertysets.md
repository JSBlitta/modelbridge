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

## Pagination — the Property Set API does not use offsets

**This is where our first implementation was wrong.** The connector's
`Pagination.pqm` sends `?top=&offset=` and inspects `offsetNext`/`total`/`next`,
and `fetchAllTrimblePages` was written to the same shape. That dialect belongs to
the **Model** API. The **Property Set** API is different, per its OpenAPI spec
(`https://api.swaggerhub.com/apis/Trimble-Connect/pset-prod/v1`, read 2026-09-11):

| | Model API | Property Set API |
|---|---|---|
| page size | `top` | `top` (max **500**, default 100) |
| cursor | `offset` (integer) | `skiptoken` (opaque), echoed as `next` |
| response | `items`, `offsetNext`, `total` | `items`, `next` only |
| end of data | short page / offset = total | **`next` absent** |

Two consequences, both of which bit us:

1. `offset` is *ignored* by the pset service, so an offset loop re-reads page 1
   forever. With `MAX_PAGES = 500` and `top = 200` that produced exactly the
   `values=100000` in the bug report — roughly two hundred real psets, each
   repeated five hundred times.
2. Stopping on a short page is also wrong here: the spec says a list operation
   "can return an empty result set and a `next` if all the items read for the page
   of results are filtered out. Client have to iterate until `next` property in the
   response is not present."

`fetchAllPsetPages` in `src/trimble-client.ts` implements that. `fetchAllTrimblePages`
stays as it was — the Model API really is offset-paged.

## Scoping to one model

Property-set libraries bind to a **project**, never to a model: the Organizer node
is `ProjectContext` → `PSetLibs` and has no model dimension. So there is no
library-to-model filter to apply. The lever the API does give is the `link` query
parameter on the psets listings, which is a plain string **prefix** filter —
Trimble's own example uses `link=frn:lib:<accountLibId>` to find every project
library derived from an account library.

`getPsetValues(defs, modelId)` uses it with two prefixes:

- `frn:tcfile:<modelId>` — covers `frn:tcfile:<fileId>/entity:<id>` and
  `frn:tcfile:<fileId>:<versionId>/entity:<id>` in one query;
- `frn:entity:` — the bare form carries no file id, so a file prefix would drop it.

`modelId` is the Model API's model id, which "equals the fileId" per the Model API
overview.

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

## The FRN grammar (documented, not inferred)

Trimble's public Postman workspace — collection *Documentation for Workflow
Extentions Integrators*, request **Property sets → Instantiating property sets →
Pointing to 3D elements** — gives the entity link forms verbatim, for an element
whose id is `0PntyzmZHFWh4O3ogKil7e`:

```
frn:entity:0PntyzmZHFWh4O3ogKil7e
frn:tcfile:q-XKNAhg3Rk/entity:0PntyzmZHFWh4O3ogKil7e
frn:tcfile:q-XKNAhg3Rk:woC32em2Fb0/entity:0PntyzmZHFWh4O3ogKil7e
```

and, for an Organizer node:

```
frn:forest:BAA01Z424_8/tree:087b105342c244608bbc65c2f0f4c765
frn:forest:BAA01Z424_8/tree:087b1053…/node:9e91a83ba1854f76aa0cede175ab8346
```

So after `frn:` the reference is a **`/`-separated** list of `type:value` parts.
The connector's `RemoveFrnPrefix` only ever split on `:`, which is why the arity
looked ambiguous from the M code alone — the `/` separator was invisible to it.

`parseFrn` now reads `entityId` (the value of the `entity` part) and `fileId`
(the `tcfile` part, version stripped) directly, and puts `entityId` first in
`candidates`. The older heuristic readings stay behind it so an undocumented link
shape still has a chance of joining. A node link yields no `entityId`, which is
correct: a pset attached to an Organizer node is not attached to a model row.

Library ids are their own case. A project library derived from an account-level
template has the composite id `[accountLibId]:[projectId]:[guid]`, which arrives
percent-encoded inside the FRN — `frn:lib:93bfd…%3ABAA01Z424_8%3A88eea…`. That is
why the library id must be decoded once and re-encoded into the URL path, and why
the log shows a `libs/…%3A…%3A…/defs` URL that looks wrong but is not.

**The diagnostic still matters.** A wrong join here is a left outer join and looks
exactly like "this project has no Trimble properties", so `mergeTrimblePsets`
counts matches and, when values exist but nothing matched, returns a note plus
sample keys from both sides.

## Still open against the live API

1. **Trailing slashes.** `RegionStatic` bases end in `/` and the connector
   concatenates inconsistently; our `joinUrl` normalises to a single slash.
2. **Whether one entity can carry the same `defId` twice** (repeatable property
   sets). The connector assumes one row per entity per def; our merge accumulates
   instead, so a second row adds properties rather than being dropped — but if the
   same property appears twice, last write wins.
3. **Whether the entity id Trimble writes into a link is the IFC GlobalId** (the
   Model API "external/source id") in every authoring tool, or sometimes the
   generated "connect" id. The candidate list and the mismatch diagnostic cover
   this; a live project with a known-good pset would settle it.
