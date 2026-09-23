import type { JestConfigWithTsJest } from 'ts-jest';

const jestConfig: JestConfigWithTsJest = {
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^(.{1,2}/.*)\\.js$': '$1',
    '\\.(css|less|sass|scss)$': '<rootDir>/tests/styleMock.cjs',
  },
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', module: 'commonjs' } }] },
};
export default jestConfig;
