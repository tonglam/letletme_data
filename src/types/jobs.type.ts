import { QueueName } from 'types/queues.type';

export interface BaseJobPayload {
  source?: string;
}

export interface MetaJobPayload extends BaseJobPayload {
  operation: 'SYNC' | 'CLEANUP';
  metaType: 'EVENTS' | 'PHASES' | 'TEAMS';
  syncFrom?: Date;
}

export interface EmailJobPayload extends BaseJobPayload {
  to: string;
  subject: string;
  body: string;
  templateVariables?: Record<string, unknown>;
}

export type AnyJobPayload = MetaJobPayload | EmailJobPayload;

export interface JobDefinition<Q extends QueueName, P extends BaseJobPayload> {
  queueName: Q;
  payload: P;
}

export type MetaJobDefinition = JobDefinition<QueueName.META, MetaJobPayload>;
export type EmailJobDefinition = JobDefinition<QueueName.EMAIL, EmailJobPayload>;

export type AnyJobDefinition = MetaJobDefinition | EmailJobDefinition;

export function isMetaJobPayload(payload: AnyJobPayload): payload is MetaJobPayload {
  return 'metaType' in payload && 'operation' in payload;
}

export function isEmailJobPayload(payload: AnyJobPayload): payload is EmailJobPayload {
  return 'to' in payload && 'subject' in payload && 'body' in payload;
}
