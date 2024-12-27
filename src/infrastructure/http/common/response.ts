import type { Response } from 'express';
import type { TaskEither } from 'fp-ts/TaskEither';
import type { APIResponse } from '../../../api/types';
import { APIError } from './errors';

export const handleResponse =
  <T>(res: Response) =>
  (task: TaskEither<APIError, APIResponse<T>>) =>
    task().then((result) => {
      if (result._tag === 'Left') {
        const { message, details } = result.left;
        return res.status(400).json({
          status: 'error',
          error: message,
          ...(details && { details }),
        });
      }
      return res.status(200).json(result.right);
    });
