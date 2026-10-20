// Client config from `VITE_*` variables (apps/web/.env; ADR 0002). Vite inlines them at build
// time; nothing secret may be among them. A missing value shows the config error screen.
import { loadPublicConfig, type PublicConfig } from '@pingdost/config/public';

function load(): { config?: PublicConfig; error?: string } {
  try {
    return { config: loadPublicConfig(import.meta.env, 'VITE_') };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'invalid configuration' };
  }
}

const loaded = load();

export const publicConfig = loaded.config;
export const configError = loaded.error;
