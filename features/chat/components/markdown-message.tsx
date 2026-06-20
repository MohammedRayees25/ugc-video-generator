import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type MarkdownMessageProps = {
  content: string;
  className?: string;
};

export function MarkdownMessage({ content, className }: MarkdownMessageProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-li:my-0 dark:prose-invert",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ className: anchorClassName, ...props }) => (
            <a
              className={cn(
                "font-medium text-primary underline underline-offset-4",
                anchorClassName
              )}
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
