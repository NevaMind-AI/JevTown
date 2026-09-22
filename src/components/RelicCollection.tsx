import { useState } from 'react';
import { RELIC_SLOTS, RelicClue } from '../../prototype/content';
import { MemoryWorld } from '../../prototype/world';
import './RelicCollection.css';

export default function RelicCollection({
  items,
  clues,
}: {
  items: ReturnType<MemoryWorld['inventoryView']>;
  clues: RelicClue[];
}) {
  const [selectedSlot, setSelectedSlot] = useState(1);
  const slots = Array.from({ length: RELIC_SLOTS }, (_, i) => {
    const slot = i + 1,
      item = items.find((item) => item.kind === 'relic' && item.slot === slot);
    return {
      slot,
      item: item && item.quantity > 0 ? item : undefined,
      clues: clues.filter((clue) => clue.slot === slot),
    };
  });
  const selected = slots[selectedSlot - 1];
  return (
    <div className="relic-collection">
      <section className="relic-grid" aria-label="遗物固定格位">
        {slots.map(({ slot, item, clues }) => (
          <button
            key={slot}
            aria-pressed={slot === selectedSlot}
            aria-label={`${item?.name ?? '未知遗物'}，格位 ${slot}，线索 ${clues.length} 条`}
            onClick={() => setSelectedSlot(slot)}
          >
            <small className="relic-slot-number">{String(slot).padStart(2, '0')}</small>
            {item ? (
              <img src={import.meta.env.BASE_URL + item.image} alt="" />
            ) : (
              <span className="relic-unknown" aria-hidden="true">
                ?
              </span>
            )}
            {clues.length > 0 && <small className="relic-clue-count">线索 {clues.length}</small>}
          </button>
        ))}
      </section>
      <section className="relic-detail" aria-label="遗物与线索详情">
        <small>收藏 · {String(selectedSlot).padStart(2, '0')}</small>
        {selected.item ? (
          <>
            <img
              className="relic-portrait"
              src={import.meta.env.BASE_URL + selected.item.image}
              alt={selected.item.name}
            />
            <h3>{selected.item.name}</h3>
            <p>
              {selected.item.category} · {selected.item.quality}
            </p>
            <p>{selected.item.description}</p>
            <section className="relic-effect">
              <h4>特殊效果</h4>
              <p>{selected.item.effectDescription || '暂无效果说明。'}</p>
            </section>
          </>
        ) : (
          <>
            <div className="relic-portrait relic-unknown" aria-hidden="true">
              ?
            </div>
            <h3>未知遗物</h3>
            <p>获得后揭示遗物的样貌、故事与特殊效果。</p>
          </>
        )}
        <section className="relic-clues" aria-label="已获得线索">
          <h4>线索 · {selected.clues.length}</h4>
          {selected.clues.length ? (
            <ol>
              {selected.clues.map((clue) => (
                <li key={clue.id}>
                  <p>{clue.text}</p>
                  <small>来源：{clue.source}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p>暂无线索。与居民交谈、探索物件时，可以把发现记录在这里。</p>
          )}
        </section>
      </section>
    </div>
  );
}
