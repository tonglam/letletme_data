import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';

/**
 * Awaits a TaskEither. If it resolves to a Right, returns the value.
 * If it resolves to a Left, throws the contained error.
 * This allows the error to be caught by Elysia's global onError handler.
 *
 * @param taskEither The TaskEither promise returned by the service.
 * @returns The success data from the Right.
 * @throws The error contained in the Left.
 */
export const unwrapOrThrow = async <L extends Error, R>(
  taskEither: TE.TaskEither<L, R>,
): Promise<R> => {
  const result = await taskEither();

  if (E.isLeft(result)) {
    throw result.left; // Throw the error for onError to catch
  }

  return result.right;
};
