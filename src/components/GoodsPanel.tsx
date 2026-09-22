import RelicCollection from './RelicCollection';
import { RelicClue } from '../../prototype/content';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { formatTime, MemoryWorld } from '../../prototype/world';
import './GoodsPanel.css';

export type GoodsMode = 'buy' | 'sell' | 'bag' | 'relics';
type Props = {
  clues: RelicClue[];
  notifications?: ReactNode;
  mode: GoodsMode | null;
  shop: ReturnType<MemoryWorld['shopView']>;
  items: ReturnType<MemoryWorld['inventoryView']>;
  balance: number;
  feedback: string;
  readOnly: boolean;
  onMode: (mode: GoodsMode | null) => void;
  onTrade: (type: 'buy' | 'sell', item: string, quantity: number) => void;
};
export default function GoodsPanel({
  mode,
  shop,
  items,
  balance,
  feedback,
  readOnly,
  onMode,
  onTrade,
  notifications,
  clues,
}: Props) {
  const panel = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState('');
  const [quantity, setQuantity] = useState('1');
  useEffect(() => {
    if (mode) {
      if (!panel.current?.open) panel.current?.showModal();
    } else panel.current?.close();
  }, [mode]);
  const collection = mode === 'relics',
    viewOnly = mode === 'bag' || collection;
  const inventory = items.filter(
    (item) => item.quantity > 0 && (collection ? item.kind === 'relic' : item.kind !== 'relic'),
  );
  const inventoryGroups = [
    {
      id: 'quest',
      title: '任务物品',
      items: inventory.filter(
        (item) => item.category === '任务物件' || item.category === '任务物品',
      ),
    },
    {
      id: 'consumable',
      title: '消耗品',
      items: inventory.filter(
        (item) => item.category !== '任务物件' && item.category !== '任务物品',
      ),
    },
  ].filter((group) => group.items.length > 0);
  const choices: (Props['items'][number] | NonNullable<Props['shop']>['offers'][number])[] =
    viewOnly ? inventory : (shop?.offers ?? []).filter((item) => mode === 'buy' || item.owned > 0);
  const selected = choices.find((item) => item.id === selectedId) ?? choices[0];
  const offer = shop?.offers.find((item) => item.id === selected?.id);
  const count = Number(quantity);
  const price = mode === 'buy' ? offer?.buySeconds : offer?.sellSeconds;
  const total = price === undefined ? 0 : price * count;
  const valid = Number.isInteger(count) && count >= 1 && count <= 99;
  const reason = readOnly
    ? '当前仅可查看'
    : !offer
      ? '请选择商品'
      : !valid
        ? '数量须为1至99的整数'
        : mode === 'buy' && offer.stock < count
          ? '商店库存不足'
          : mode === 'sell' && offer.owned < count
            ? '背包数量不足'
            : mode === 'buy' && balance < total
              ? '生命余额不足'
              : '';
  const image = (path: string) => `${import.meta.env.BASE_URL}${path}`;
  const select = (id: string) => {
    setSelectedId(id);
    setQuantity('1');
  };
  return (
    <dialog
      ref={panel}
      className="goods-panel"
      aria-labelledby="goods-title"
      onClose={() => onMode(null)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {notifications}
      <header>
        <div>
          <p>余时遗物</p>
          <h2 id="goods-title">
            {collection ? '遗物收藏' : mode === 'bag' ? '背包' : (shop?.name ?? '商店')}
          </h2>
        </div>
        <div className="goods-balance">
          生命余额 <strong>{formatTime(balance)}</strong>
        </div>
        <button autoFocus aria-label="关闭商品面板" onClick={() => onMode(null)}>
          ×
        </button>
      </header>
      <nav aria-label="商品页面">
        {shop && (
          <>
            <button
              aria-pressed={mode === 'buy'}
              onClick={() => {
                onMode('buy');
                setQuantity('1');
              }}
            >
              买入
            </button>
            <button
              aria-pressed={mode === 'sell'}
              onClick={() => {
                onMode('sell');
                setQuantity('1');
              }}
            >
              卖出
            </button>
          </>
        )}
        {collection ? (
          <span>
            已收藏 {inventory.length} 种遗物 · 已获线索 {clues.length} 条
          </span>
        ) : (
          <button aria-pressed={mode === 'bag'} onClick={() => onMode('bag')}>
            背包（{inventory.reduce((sum, item) => sum + item.quantity, 0)}）
          </button>
        )}
      </nav>
      {collection ? (
        <RelicCollection items={items} clues={clues} />
      ) : (
        <div className="goods-body">
          <section
            className={viewOnly ? 'goods-list goods-bag' : 'goods-list'}
            aria-label={collection ? '遗物列表' : mode === 'bag' ? '背包物品' : '商品列表'}
          >
            {viewOnly && !collection
              ? inventoryGroups.map((group) => (
                  <div key={group.id} className="goods-group">
                    <h3>{group.title}</h3>
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={selected?.id === item.id}
                        onClick={() => select(item.id)}
                      >
                        <img src={image(item.image)} alt="" />
                        <span>
                          <strong>{item.name}</strong>
                          <small>数量 {item.quantity}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                ))
              : choices.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={selected?.id === item.id}
                    onClick={() => select(item.id)}
                  >
                    <img src={image(item.image)} alt="" />
                    <span>
                      <strong>{item.name}</strong>
                      {'stock' in item ? (
                        <>
                          <small>
                            {formatTime(mode === 'sell' ? item.sellSeconds : item.buySeconds)} / 件
                          </small>
                          <small>
                            库存 {item.stock} · 已拥有 {item.owned}
                          </small>
                        </>
                      ) : (
                        <small>数量 {item.quantity}</small>
                      )}
                    </span>
                  </button>
                ))}
            {!choices.length && (
              <p>
                {collection
                  ? '尚未获得遗物。探索与任务中获得的遗物会收藏在这里。'
                  : mode === 'sell'
                    ? '没有可向这位商人卖出的物品。'
                    : '背包还是空的，去绯月的小铺看看吧。'}
              </p>
            )}
          </section>
          <section className="goods-detail" aria-label="物品详情">
            {selected ? (
              <>
                <div className="goods-hero">
                  <img src={image(selected.image)} alt={selected.name} />
                  <p>
                    {selected.category}
                    <strong>{selected.quality}</strong>
                  </p>
                </div>
                <h3>{selected.name}</h3>
                <p>{selected.description}</p>
                <p>已拥有 {items.find((item) => item.id === selected.id)?.quantity ?? 0} 件</p>
                {selected.kind === 'relic' && (
                  <section className="relic-effect">
                    <h4>特殊效果</h4>
                    <p>{selected.effectDescription || '暂无效果说明。'}</p>
                  </section>
                )}
                {!viewOnly && (
                  <div className="goods-order">
                    <div className="goods-quantity">
                      <label htmlFor="trade-quantity">
                        {mode === 'buy' ? '购买数量' : '卖出数量'} {count}
                      </label>
                      <div>
                        <button
                          aria-label="减少数量"
                          disabled={count <= 1}
                          onClick={() => setQuantity(String(Math.max(1, count - 1)))}
                        >
                          −
                        </button>
                        <span>1</span>
                        <input
                          id="trade-quantity"
                          aria-label="交易数量"
                          aria-valuetext={`${count} 件`}
                          type="range"
                          min="1"
                          max="99"
                          step="1"
                          value={quantity}
                          onChange={(event) => setQuantity(event.target.value)}
                        />
                        <span>99</span>
                        <button
                          aria-label="增加数量"
                          disabled={count >= 99}
                          onClick={() => setQuantity(String(Math.min(99, count + 1)))}
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <p>
                      {mode === 'buy' ? '支付余时' : '获得余时'}{' '}
                      <strong>{valid ? formatTime(total) : '—'}</strong>
                    </p>
                    <button
                      disabled={!!reason}
                      onClick={() => {
                        if (!reason) onTrade(mode === 'sell' ? 'sell' : 'buy', selected.id, count);
                      }}
                    >
                      {mode === 'buy' ? '确认买入' : '确认卖出'}
                    </button>
                    <small>
                      {reason ||
                        (mode === 'buy'
                          ? '按当前价格结算，买入不能透支。'
                          : '卖出后物品回到商店库存。')}
                    </small>
                  </div>
                )}
              </>
            ) : (
              <p className="goods-empty">
                {collection
                  ? '每件遗物都有自己的故事。'
                  : mode === 'bag'
                    ? '购买后，物品会收进这里。'
                    : '切换到买入，看看今夜供应的商品。'}
              </p>
            )}
            <p role="status" className="goods-feedback">
              {feedback}
            </p>
          </section>
        </div>
      )}
    </dialog>
  );
}
