import type { OrganizerApi, ProjectTree } from '../apis/organizer.js';

export interface ApiChecks {
  organizer: ProjectTree[] | false;
  propertySet: string[] | false;
}

export async function checkApis(
  organizerApi: OrganizerApi,
  projectId: string,
): Promise<ApiChecks> {
  const [organizerTrees, libIds] = await Promise.all([
    organizerApi.getProjectTrees(projectId),
    organizerApi.getProjectLibraryIds(projectId),
  ]);

  return {
    organizer: organizerTrees.length > 0 ? organizerTrees : false,
    propertySet: libIds.length > 0 ? libIds : false,
  };
}
