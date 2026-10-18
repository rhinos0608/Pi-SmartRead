declare const app: { get(path: string, handler: unknown): void };
declare const handler: unknown;
app.get('/real', handler);
// Decoy: app.get('/decoy', handler);
