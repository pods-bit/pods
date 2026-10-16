/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_BASE?: string;
  readonly VITE_RPC_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
