import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'server',
  session: false,
  adapter: cloudflare({
    imageService: 'passthrough',
    prerenderEnvironment: 'node'
  }),
  site: 'https://federalgranttracker.com',
  integrations: [sitemap()]
});
