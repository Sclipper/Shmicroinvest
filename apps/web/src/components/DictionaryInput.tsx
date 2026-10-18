import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api.ts';
import { TextInput } from './ui.tsx';

/** Free text with suggestions from Основания / Забележки / Параграфи (most used first). */
export function DictionaryInput({ type, value, onChange, placeholder, className }: { type: 'terms' | 'references' | 'paragraphs'; value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const id = useId();
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['dictionary', type, q],
    queryFn: () => api.get<{ id: number; description: string }[]>(`/dictionary/${type}${qs({ q, limit: 30 })}`),
    staleTime: 30_000,
  });
  return (
    <>
      <TextInput
        list={id}
        value={value}
        placeholder={placeholder}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          setQ(e.target.value);
        }}
      />
      <datalist id={id}>
        {data.map((d) => (
          <option key={d.id} value={d.description} />
        ))}
      </datalist>
    </>
  );
}
