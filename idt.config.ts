import type { IdtConfig } from './src/idt/schemas/config.schema.js';

const config: IdtConfig = {
  pageGlobs: [
    'src/pages/**/*.{tsx,jsx,ts,js,vue}',
    'src/app/**/page.{tsx,jsx}',
    'src/views/**/*.{tsx,jsx,ts,js,vue}',
  ],
  localeFiles: ['src/locales/zh-CN.json', 'locales/zh-CN.json'],
  routerGlobs: [],
};

export default config;
