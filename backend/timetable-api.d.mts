import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TimetableRepository } from './timetable-repository.mjs'

export function createTimetableApiMiddleware(repository: TimetableRepository): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>
