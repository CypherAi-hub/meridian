/** A Jupiter credential belongs only to the official authenticated API. */
export function jupiterHeaders(endpoint: string, key: string | null | undefined): Record<string,string> {
 const headers: Record<string,string>={accept:'application/json'};
 const url=new URL(endpoint);
 if(key && url.origin==='https://api.jup.ag') headers['x-api-key']=key;
 return headers;
}
