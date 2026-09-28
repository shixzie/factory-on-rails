import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ node: _, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  a: ({ node: _, ...props }) => (
    <a className="font-medium text-primary underline underline-offset-4" target="_blank" rel="noreferrer" {...props} />
  ),
  ul: ({ node: _, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node: _, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node: _, ...props }) => <li className="pl-0.5" {...props} />,
  h1: ({ node: _, ...props }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...props} />,
  h2: ({ node: _, ...props }) => <h3 className="mt-4 mb-2 text-[15px] font-semibold first:mt-0" {...props} />,
  h3: ({ node: _, ...props }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0" {...props} />,
  h4: ({ node: _, ...props }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0" {...props} />,
  blockquote: ({ node: _, ...props }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props} />,
  hr: () => <hr className="my-4" />,
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border bg-code p-3 font-mono text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  code: ({ node: _, className, ...props }) => (
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...props} />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => <th className="border-b px-2 py-1.5 font-medium" {...props} />,
  td: ({ node: _, ...props }) => <td className="border-b px-2 py-1.5 align-top" {...props} />,
};

/** The agent's prose. Raw HTML in it is not rendered. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
