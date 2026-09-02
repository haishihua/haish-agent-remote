import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.haish.agent.remote',
  appName: 'Haish',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;
