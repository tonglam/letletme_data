import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';

export const unwrapOrThrow = async <L extends Error, R>(
  taskEither: TE.TaskEither<L, R>,
): Promise<R> => {
  const result = await taskEither();

  if (E.isLeft(result)) {
    throw result.left;
  }

  return result.right;
};
