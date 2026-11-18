import { Button } from '../agora-kit/ui/button';
import { FileIcon } from './icons';

/** The shared fallback surface: a glyph, a message, and a link to the original in a new tab. Used
 *  whenever inline rendering isn't available (unknown type or a read error). */
export function FallbackCard({ item, message }: { item: { url: string }; message: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center gap-4 px-6 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="grid size-14 place-items-center rounded-lg border border-border bg-panel-2 text-faint [&_svg]:size-6">
          <FileIcon />
        </div>
        <div className="mono max-w-md text-sm text-dim">{message}</div>
        <Button
          nativeButton={false}
          render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}
        >
          Open original ↗
        </Button>
      </div>
    </div>
  );
}
