import { Field, FieldDescription, FieldLabel } from "@databricks/appkit-ui/react";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

/** What a FormRow passes to its control, so the label, the description and the issues reach assistive tech. */
export interface FormRowControl {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean;
}

export interface FormRowProps {
  label: ReactNode;
  /** The key in the YAML file, shown beside the label in mono. */
  yamlKey?: string;
  description?: ReactNode;
  /** Rule issues for this field; shown under it and linked to the control. */
  errors?: string[];
  className?: string;
  children: (control: FormRowControl) => ReactNode;
}

/**
 * One form field built from appkit-ui's Field primitives: label, control,
 * description and issues. The issues are linked to the control with
 * aria-describedby and aria-invalid, and are not a live region, so typing does
 * not announce every check.
 */
export function FormRow({ label, yamlKey, description, errors = [], className, children }: FormRowProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const invalid = errors.length > 0;
  const describedBy = [description ? descriptionId : null, invalid ? errorId : null].filter((part) => part !== null).join(" ") || undefined;
  return (
    <Field className={cn("gap-1.5", className)}>
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-2">
        <FieldLabel htmlFor={id} className={cn("text-[13px]", invalid && "text-destructive")}>
          {label}
        </FieldLabel>
        {yamlKey ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground" aria-hidden="true">
            {yamlKey}
          </code>
        ) : null}
      </div>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": invalid })}
      {description ? (
        <FieldDescription id={descriptionId} className="text-xs leading-4">
          {description}
        </FieldDescription>
      ) : null}
      {invalid ? (
        <div id={errorId} className="grid gap-0.5 text-xs leading-4 text-destructive">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
    </Field>
  );
}
