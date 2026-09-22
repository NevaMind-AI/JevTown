import type { JestConfigWithTsJest } from 'ts-jest';

const jestConfig: JestConfigWithTsJest = {
  preset: 'ts-jest/presets/default-esm',
  // Suites live beside the code in agent/, engine/, server/ and src/, and under tests/ for
  // the prototype engine and the React layer.
  roots: [
    '<rootDir>/tests',
    '<rootDir>/agent',
    '<rootDir>/engine',
    '<rootDir>/server',
    '<rootDir>/src',
  ],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^(.{1,2}/.*)\\.js$': '$1',
    '\\.css$': '<rootDir>/jest/styleStub.ts',
  },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { jsx: 'react-jsx' } }] },
};
export default jestConfig;
