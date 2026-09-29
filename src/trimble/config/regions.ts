import type { RegionEndpoints } from '../types/index.js';

const endpointMap: Record<string, RegionEndpoints> = {
  Europe: {
    Core: 'https://app21.connect.trimble.com/tc/api/2.0/',
    Organizer: 'https://org-api.eu-west-1.connect.trimble.com/v1/',
    Propertyset: 'https://pset-api.eu-west-1.connect.trimble.com/v1/',
    Model: 'https://model-api21.connect.trimble.com/',
    Topic: 'https://open21.connect.trimble.com/',
    'Model-feature': 'https://model-wf21.connect.trimble.com/v1/',
  },
};

export function getRegionEndpoints(region: string): RegionEndpoints {
  const endpoints = endpointMap[region];
  if (!endpoints) {
    throw new Error(`Unknown region: ${region}. Valid regions: ${Object.keys(endpointMap).join(', ')}`);
  }
  return endpoints;
}

export function listRegions(): string[] {
  return Object.keys(endpointMap);
}
