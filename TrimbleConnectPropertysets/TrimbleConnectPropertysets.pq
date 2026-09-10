[Version = "0.9.0"]
section TrimbleConnectPropertysets;

TrimbleConnectPropertysets.Publish = [
    Beta            = true,
    Category        = "Online Services",
    DisplayName     = Extension.LoadString("Title"),
    ButtonText      = {Extension.LoadString("ButtonTitle"), Extension.LoadString("ButtonHelp")},
    LearnMoreUrl    = "https://powerbi.microsoft.com/",
    SourceImage     = TrimbleConnectPropertysets.Icons,
    SourceTypeImage = TrimbleConnectPropertysets.Icons
];

Configuration             = Json.Document(Extension.Contents("Configuration.json"));
QueryParameters           = Configuration[queryParameters];
ConnectorSettings         = Configuration[connectorSettings];
modelAPI                  = Configuration[modelAPI];
RegionalEndpoints         = Extension.LoadFunction("RegionalEndpoints.pqm");
RegionStatic              = RegionalEndpoints[RegionStatic];
Regions                   = RegionalEndpoints[Regions];
OAuth                     = Extension.LoadFunction("OAuth.pqm");
FetchPages                = Extension.LoadFunction("Pagination.pqm")[FetchPages];
MergeEntitiesWithPSetDefs = Extension.LoadFunction("Helpers.pqm")[MergeEntitiesWithPSetDefs];
SchemaTransformTable      = Extension.LoadFunction("Helpers.pqm")[SchemaTransformTable];

Table.ToNavigationTable = Extension.LoadFunction("Helpers.pqm")[Table.ToNavigationTable];

FilterBuilder = Extension.LoadFunction("Helpers.pqm")[FilterBuilder];
EnrichWithReleases = Extension.LoadFunction("Helpers.pqm")[EnrichWithReleases];
GetReleases          = Extension.LoadFunction("Core.pqm")[GetReleases];
GetReleaseFiles      = Extension.LoadFunction("Core.pqm")[GetReleaseFiles];
GetProjects          = Extension.LoadFunction("Core.pqm")[GetProjects];
SearchProject        = Extension.LoadFunction("Core.pqm")[SearchProject];
GetFolderItems       = Extension.LoadFunction("Core.pqm")[GetFolderItems];
GetFolderContent     = Extension.LoadFunction("Core.pqm")[GetFolderContent];
GetPSetDefs          = Extension.LoadFunction("Model.pqm")[GetPSetDefs];
GetProjectLibraryIds = Extension.LoadFunction("Organizer.pqm")[GetProjectLibraryIds];
GetProjectTrees      = Extension.LoadFunction("Organizer.pqm")[GetProjectTrees];
GetInfoContent       = Extension.LoadFunction("Infobox.pqm")[GetInfoContent];

RegionRecord = [
    Europe       = Extension.LoadString("RegionEurope"),
    NorthAmerica = Extension.LoadString("RegionNorthAmerica"),
    Asia         = Extension.LoadString("RegionAsia"),
    Australia    = Extension.LoadString("RegionAustralia")
];

ReleasesRecord = [
    true  = Extension.LoadString("ReleasesTrue"),
    false = Extension.LoadString("ReleasesFalse")
];

InfoboxRecord = [
    true  = Extension.LoadString("InfoboxTrue"),
    false = Extension.LoadString("InfoboxFalse")
];

FolderOverrideRecord = [
    true  = Extension.LoadString("FolderOverrideTrue"),
    false = Extension.LoadString("FolderOverrideFalse")
];

TrimbleConnectPropertysets = [
    TestConnection = (dataSourcePath) => true,
    Authentication = [
        OAuth = [
            StartLogin  = OAuth[StartLogin],
            FinishLogin = OAuth[FinishLogin],
            Refresh     = OAuth[Refresh]
        ]
    ],
    Label = Extension.LoadString("LoginUI")
];

[DataSource.Kind = "TrimbleConnectPropertysets", Publish = "TrimbleConnectPropertysets.Publish"]
shared TrimbleConnectPropertysets.Contents = Value.ReplaceType(
    TrimbleConnectPropertysets_Factory, TrimbleConnectPropertysets_Type
);

TrimbleConnectPropertysets_Type = type function (
    region as (
        type text meta [
            Documentation.FieldCaption     = "Region",
            Documentation.FieldDescription = Extension.LoadString("RegionDescription"),
            Documentation.AllowedValues    = Record.FieldValues(RegionRecord),
            DataSource.Path                = false
        ]
    ),
    optional Company as (
        type nullable [
            optional projectRef = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("ProjectRefCaption"),
                    Documentation.FieldDescription = Extension.LoadString("ProjectRefDescription"),
                    Documentation.SampleValues     = "12673 or Coolsingel 93"
                ]
            ),
            optional companyFolderOverride = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("CompanyFolderOverrideCaption"),
                    Documentation.FieldDescription = Extension.LoadString("CompanyFolderOverrideDescription"),
                    Documentation.AllowedValues    = Record.FieldValues(FolderOverrideRecord)
                ]
            ),
            optional infobox = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("InfoboxCaption"),
                    Documentation.FieldDescription = Extension.LoadString("InfoboxDescription"),
                    Documentation.AllowedValues    = Record.FieldValues(InfoboxRecord)
                ]
            )
        ] meta [
            Documentation.FieldCaption = Extension.LoadString("CompanyOptions")
        ]
    ),
    optional Model as (
        type nullable [
            optional releases = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("ReleasesCaption"),
                    Documentation.FieldDescription = Extension.LoadString("ReleasesDescription"),
                    Documentation.AllowedValues    = Record.FieldValues(ReleasesRecord)
                ]
            ),
            optional fields = (
                type list meta [
                    Documentation.FieldCaption     = Extension.LoadString("FieldsCaption"),
                    Documentation.FieldDescription = Extension.LoadString("FieldsDescription"),
                    Documentation.AllowedValues    = List.RemoveItems(
                        modelAPI[allowedFields], ConnectorSettings[standardFields]
                    ),
                    Documentation.SampleValues = Extension.LoadString("FieldsSample")
                ]
            )
        ] meta [
            Documentation.FieldCaption = Extension.LoadString("ModelOptions")
        ]
    ),
    optional Filter as (
        type nullable [
            optional filterFunctions = (
                type list meta [
                    Documentation.AllowedValues    = QueryParameters[FunctionAllowedValues],
                    Documentation.FieldCaption     = Extension.LoadString("FilterFunctionsCaption"),
                    Documentation.FieldDescription = Extension.LoadString("FilterFunctionsDescription"),
                    Documentation.SampleValues     = Extension.LoadString("FilterFunctionsSample")
                ]
            ),
            optional filterProperties = (
                type list meta [
                    Documentation.AllowedValues    = QueryParameters[PropertiesAllowedValues],
                    Documentation.FieldCaption     = Extension.LoadString("FilterPropertiesCaption"),
                    Documentation.FieldDescription = Extension.LoadString("FilterPropertiesDescription"),
                    Documentation.SampleValues     = Extension.LoadString("FilterPropertiesSample")
                ]
            ),
            optional filterValues = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("FilterValueCaption"),
                    Documentation.FieldDescription = Extension.LoadString("FilterValueDescription"),
                    Documentation.SampleValues     = Extension.LoadString("FilterValueSample")
                ]
            ),
            optional filterFreeform = (
                type text meta [
                    Documentation.FieldCaption     = Extension.LoadString("FilterFreeformCaption"),
                    Documentation.FieldDescription = Extension.LoadString("FilterFreeformDescription"),
                    Documentation.SampleValues     = Extension.LoadString("FilterFreeformSample")
                ]
            )
        ] meta [
            Documentation.FieldCaption = Extension.LoadString("FilterOptions")
        ]
    )
) as table meta [
    Documentation.Name            = Extension.LoadString("Title"),
    Documentation.Description     = Extension.LoadString("ConnectorDescription"),
    Documentation.LongDescription = Extension.LoadString("ConnectorLongDescription")
];

TrimbleConnectPropertysets_Factory = (
    region as text, optional CompanyOptions as record, optional ModelOptions as record, optional FilterOptions as record
) as table =>
    let
            // Create cache key for memoization
        cacheKey = Text.Combine({
            region,
            Text.From(CompanyOptions),
            Text.From(ModelOptions),
            Text.From(FilterOptions)
        }, "|"),
        
            // Extract options with null safety
        c = if CompanyOptions = null then [] else CompanyOptions,
        m = if ModelOptions   = null then [] else ModelOptions,
        f = if FilterOptions  = null then [] else FilterOptions,
        
            // Extract individual parameters
        projectRef            = Record.FieldOrDefault(c, "projectRef", null),
        companyFolderOverride = Record.FieldOrDefault(c, "companyFolderOverride", null),
        infobox               = Record.FieldOrDefault(c, "infobox", null),
        releases              = Record.FieldOrDefault(m, "releases", null),
        fields                = Record.FieldOrDefault(m, "fields", null),
        filterFunctions       = Record.FieldOrDefault(f, "filterFunctions", null),
        filterProperties      = Record.FieldOrDefault(f, "filterProperties", null),
        filterValues          = Record.FieldOrDefault(f, "filterValues", null),
        filterFreeform        = Record.FieldOrDefault(f, "filterFreeform", null),
        
            // Call implementation function with parameters
        result = TrimbleImpl(
            region,
            projectRef,
            companyFolderOverride,
            infobox,
            releases,
            fields,
            filterFunctions,
            filterProperties,
            filterValues,
            filterFreeform
        )
    in
        result;

TrimbleImpl = (
    region as text,
    optional projectRef as text,
    optional companyFolderOverride as text,
    optional infobox as text,
    optional releases as text,
    optional fields as list,
    optional filterFunctions as list,
    optional filterProperties as list,
    optional filterValues as text,
    optional filterFreeform as text
) as table =>
    let
            // Clean and prepare fields parameter
        cleanInput = if fields <> null then List.RemoveMatchingItems(fields, {"id", "idc", "idx"}) else {},
        
            // Combine with standard fields and ensure uniqueness
        allFields    = List.Buffer(List.Combine({ConnectorSettings[standardFields], cleanInput})),
        filteredList = List.Buffer(List.Distinct(allFields)),
        
            // Build fields query string efficiently
        fieldsQuery = 
            let
                    // Use a more efficient approach for building the query string
                fieldsList = if List.IsEmpty(filteredList) then
                                {"id"}  // Ensure at least one field
                             else
                                filteredList,
                                
                    // Join fields with commas
                joinedFields = Text.Combine(fieldsList, ",")
            in
                "&fields=" & joinedFields,
        
            // Build filter string
        filterString = 
            if
                (filterFunctions <> null and filterProperties <> null and filterValues <> null)
                or filterFreeform <> null
            then
                FilterBuilder(filterFunctions, filterProperties, filterValues, filterFreeform)
            else
                "",
        regionValues = Record.FieldValues(RegionRecord),
        regionFields = Record.FieldNames(RegionRecord),
        regionName   = 
            try
                regionFields{List.PositionOf(regionValues, region)}
            otherwise
                error
                    [
                        Reason  = "Validation.Failed",
                        Message = Extension.LoadString("RegionError")
                            & region & ". ",
                        Detail = Extension.LoadString("RegionErrorFeedback")
                            & Text.Combine(regionValues, ", ")
                    ],
           API             = Regions(regionName),
           infoBoxFields   = Record.FieldNames(InfoboxRecord),
           infoBoxValues   = Record.FieldValues(InfoboxRecord),
           infoBoxIndex    = List.PositionOf(infoBoxValues, infobox),
           infoBoxLogical  = if infoBoxIndex >= 0 then Logical.FromText(infoBoxFields{infoBoxIndex}) else false as logical,
           releasesFields  = Record.FieldNames(ReleasesRecord),
           releasesValues  = Record.FieldValues(ReleasesRecord),
           releasesIndex   = List.PositionOf(releasesValues, releases),
           releasesLogical = 
        if releasesIndex  >= 0 then
                Logical.FromText(releasesFields{releasesIndex})
            else
                false as logical,
           folderOverrideFields      = Record.FieldNames(FolderOverrideRecord),
           folderOverrideValues      = Record.FieldValues(FolderOverrideRecord),
           folderOverrideIndex       = List.PositionOf(folderOverrideValues, companyFolderOverride),
           folderOverrideLogical     = 
        if folderOverrideIndex     >= 0 then
                Logical.FromText(folderOverrideFields{folderOverrideIndex})
            else
                false as logical,
            // Search for project if reference provided
projectId = if projectRef <> null then SearchProject(API, projectRef) else "",

projectsTable = Table.Buffer(GetProjects(API)),

projectReffed = if not (projectId = null or projectId = "")
    then Table.SelectRows(projectsTable, each [id] = projectId) 
    else projectsTable,

withData = if releasesLogical = true then
    EnrichWithReleases(projectReffed, API, fieldsQuery, filterString)
else
    Table.AddColumn(projectReffed, "Data", each
        GetFolderContent(API, [rootId], projectId, fieldsQuery, [checks], filterString, folderOverrideLogical),
        type table
    ),

navTable = Table.ToNavigationTable(
    withData,
    {"id"},
    "name",
    "Data",
    "type",
    "name",
    "IsLeaf"
)

    in
        navTable;

shared Extension.LoadFunction = (fileName as text) =>
    let
        binary = Extension.Contents(fileName), asText = Text.FromBinary(binary)
    in
        Expression.Evaluate(asText, #shared) meta [
            Documentation.Name            = Extension.LoadString("LoadFunctionName"),
            Documentation.Description     = Extension.LoadString("LoadFunctionDescription"),
            Documentation.LongDescription = Extension.LoadString("LoadFunctionLongDescription")
        ];

TrimbleConnectPropertysets.Icons = [
    Icon16 = {
        Extension.Contents("TrimbleConnectPropertysets16.png"),
        Extension.Contents("TrimbleConnectPropertysets20.png"),
        Extension.Contents("TrimbleConnectPropertysets24.png"),
        Extension.Contents("TrimbleConnectPropertysets32.png")
    },
    Icon32 = {
        Extension.Contents("TrimbleConnectPropertysets32.png"),
        Extension.Contents("TrimbleConnectPropertysets40.png"),
        Extension.Contents("TrimbleConnectPropertysets48.png"),
        Extension.Contents("TrimbleConnectPropertysets64.png")
    }
];
