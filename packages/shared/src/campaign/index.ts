/**
 * Campaign and organisational operations (blueprint 5, 10, 15.3, 15.4):
 * departments and teams, tasks, events, communications, finance, the report
 * builder, the notification centre and the breach register. Tenant module
 * `campaign` (finance has its own permission family; operations roles never
 * hold it). API contract §23–30.
 */
export * from './enums';
export * from './common';
export * from './org';
export * from './tasks';
export * from './events';
export * from './comms';
export * from './finance';
export * from './reports';
export * from './notifications';
export * from './breach';
export * from './requests';
