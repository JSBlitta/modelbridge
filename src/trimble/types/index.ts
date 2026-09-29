export interface RegionEndpoints {
  Core: string;
  Organizer: string;
  Propertyset: string;
  Model: string;
  Topic: string;
  'Model-feature': string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}
