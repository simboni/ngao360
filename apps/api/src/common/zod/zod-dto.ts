import type { z, ZodTypeAny } from 'zod';

export interface ZodDtoStatic<T extends ZodTypeAny = ZodTypeAny> {
  new (): z.infer<T>;
  readonly zodSchema: T;
}

/**
 * Create a DTO class from a zod schema in @ngao360/shared. The global
 * ZodValidationPipe validates any @Body/@Query/@Param typed with such a class.
 *
 *   export class LoginDto extends createZodDto(LoginRequestSchema) {}
 *   @Post('login') login(@Body() dto: LoginDto) { ... }
 */
export function createZodDto<T extends ZodTypeAny>(schema: T): ZodDtoStatic<T> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  return ZodDto as unknown as ZodDtoStatic<T>;
}

export function isZodDto(metatype: unknown): metatype is ZodDtoStatic {
  return typeof metatype === 'function' && 'zodSchema' in metatype;
}
