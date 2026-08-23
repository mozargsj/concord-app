import type { ButtonHTMLAttributes } from 'react';
import '../styles/Button.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
}

export default function Button({ variant = 'primary', className, ...rest }: ButtonProps) {
  const classes = ['button', `button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} {...rest} />;
}
