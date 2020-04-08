declare module 'default-browser' {
  function lookup(): Promise<{ name: string, id: string }>;

  export = lookup;
}
