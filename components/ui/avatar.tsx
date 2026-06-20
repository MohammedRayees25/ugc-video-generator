import { Bot, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

type AvatarProps = {
  role: "assistant" | "user";
  className?: string;
};

export function Avatar({ role, className }: AvatarProps) {
  const Icon = role === "assistant" ? Bot : UserRound;

  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm",
        role === "assistant" && "bg-primary text-primary-foreground",
        className
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </div>
  );
}
