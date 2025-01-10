import type { JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  modulePaths: ['<rootDir>'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^src/(.*)$': '<rootDir>/src/$1',
    '^infrastructure/(.*)$': '<rootDir>/src/infrastructures/$1',
    '^services/(.*)$': '<rootDir>/src/services/$1',
    '^domains/(.*)$': '<rootDir>/src/domains/$1',
  },
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: {
          ignoreCodes: [1343],
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleDirectories: ['node_modules', 'src'],
};

export default config;
