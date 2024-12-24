/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  modulePaths: ['<rootDir>'],
  moduleNameMapper: {
    '^infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
    '^services/(.*)$': '<rootDir>/src/services/$1',
    '^domains/(.*)$': '<rootDir>/src/domains/$1',
  },
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};
