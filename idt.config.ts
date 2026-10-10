import type { IdtConfig } from './src/idt/schemas/config.schema';

const config: IdtConfig = {
  pageGlobs: [
    'src/pages/**/*.{tsx,jsx,ts,js}',
    'src/app/**/page.{tsx,jsx}',
    'src/views/**/*.{tsx,jsx,ts,js}',
  ],
  localeFiles: ['src/locales/zh-CN.json', 'locales/zh-CN.json'],
};

export default config;
