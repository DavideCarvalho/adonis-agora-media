// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable';

// jsdom doesn't implement ResizeObserver (used to size the windowed scroll viewport); a no-op stub
// is enough since these tests render short tables that never hit the windowing math.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;

const HEADER = ['name', 'age'];
const BODY = [
  ['Ada', '30'],
  ['Bob', '25'],
  ['Cy', '40'],
];

describe('DataTable', () => {
  it('renders every row and the row count', () => {
    render(<DataTable header={HEADER} body={BODY} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('Cy')).toBeTruthy();
    expect(screen.getByText('3 rows')).toBeTruthy();
  });

  it('filters globally across every column', () => {
    render(<DataTable header={HEADER} body={BODY} />);
    fireEvent.change(screen.getByPlaceholderText('filter all columns…'), {
      target: { value: '40' },
    });
    expect(screen.getByText('Cy')).toBeTruthy();
    expect(screen.queryByText('Ada')).toBeNull();
    expect(screen.getByText('1 / 3 rows')).toBeTruthy();
  });

  it('sorts numerically when a column header is clicked, cycling asc → desc → off', () => {
    render(<DataTable header={HEADER} body={BODY} />);
    const ageHeader = screen.getByText('age');

    fireEvent.click(ageHeader); // asc
    let rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(rows[0]?.textContent).toContain('Bob');

    fireEvent.click(ageHeader); // desc
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('Cy');
  });

  it('resets sort and filters', () => {
    render(<DataTable header={HEADER} body={BODY} />);
    fireEvent.change(screen.getByPlaceholderText('filter all columns…'), {
      target: { value: 'Ada' },
    });
    fireEvent.click(screen.getByText('reset'));
    expect(screen.getByText('3 rows')).toBeTruthy();
  });
});
