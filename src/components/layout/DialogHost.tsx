import { useEffect, useState } from "react";
import { useUi } from "@/store/ui";
import { Button, Dialog, Field, Input } from "@/components";

/** Questions and prompts asked through `useUi().ask / prompt`. */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  const [value, setValue] = useState("");

  useEffect(() => setValue(dialog?.input?.value ?? ""), [dialog]);

  const primary = dialog?.buttons.find((b) => b.variant === "primary" || b.variant === "danger") ?? dialog?.buttons[0];

  return (
    <Dialog open={!!dialog} onClose={() => dialog && close(dialog.cancelId, value)} label={dialog?.title ?? "Dialog"} className="w-[460px]">
      {dialog && (
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (primary) close(primary.id, value);
          }}
        >
          <div className="text-[15px] font-semibold text-[var(--text-main)]">{dialog.title}</div>
          {dialog.message && <div className="selectable text-[13px] leading-relaxed text-[var(--text-muted)]">{dialog.message}</div>}
          {dialog.input && (
            <Field label={dialog.input.label ?? ""}>
              <Input
                data-autofocus
                autoFocus
                type={dialog.input.password ? "password" : "text"}
                mono={dialog.input.mono}
                placeholder={dialog.input.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-row-reverse gap-2">
            {dialog.buttons.map((b, i) => (
              <Button
                key={b.id}
                type={b === primary ? "submit" : "button"}
                data-autofocus={!dialog.input && i === 0 ? true : undefined}
                variant={b.variant === "danger" ? "danger" : b.variant === "primary" ? "primary" : "secondary"}
                onClick={b === primary ? undefined : () => close(b.id, value)}
              >
                {b.label}
              </Button>
            ))}
          </div>
        </form>
      )}
    </Dialog>
  );
}
