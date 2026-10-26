import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/**/*.test.ts','dashboard/**/*.test.ts'],fileParallelism:false,maxWorkers:1,testTimeout:30000}});
