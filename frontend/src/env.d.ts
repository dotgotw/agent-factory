// Vite 環境變數宣告(Infra 維護)
interface ImportMetaEnv { readonly VITE_API_BASE?: string }
interface ImportMeta { readonly env?: ImportMetaEnv }
