import { greet } from '@tf/clean';

export const apiUrl = (): string => process.env.API_URL ?? '/api';
export const hello = (): string => greet('web');
