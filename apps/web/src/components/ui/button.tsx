import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-teal text-white hover:bg-teal/90 disabled:bg-teal/50',
  secondary: 'border border-line bg-surface text-ink hover:bg-cloud disabled:text-slate',
  ghost: 'text-ink hover:bg-cloud',
  danger: 'bg-error text-white hover:bg-error/90 disabled:bg-error/50',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-3 text-meta' : 'h-10 px-4 text-body',
        VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
});
