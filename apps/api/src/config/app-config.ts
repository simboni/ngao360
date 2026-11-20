import { Injectable } from '@nestjs/common';
import { type AppConfigValues, loadConfig } from './config.schema';

/** Typed, validated configuration. Inject `AppConfig` and read `config.values`. */
@Injectable()
export class AppConfig {
  readonly values: AppConfigValues;

  constructor(values?: AppConfigValues) {
    this.values = values ?? loadConfig();
  }

  get isProduction(): boolean {
    return this.values.NODE_ENV === 'production';
  }
}
