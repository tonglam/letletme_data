import type { TaskEither } from 'fp-ts/TaskEither';

export interface Cache {
  get: <T>(key: string) => TaskEither<Error, T>;
  set: <T>(key: string, value: T) => TaskEither<Error, void>;
  del: (key: string) => TaskEither<Error, void>;
}
