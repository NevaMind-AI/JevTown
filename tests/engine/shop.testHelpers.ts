import { loadContent } from '../../prototype/content';

// Commerce regressions use a small shop, independent of playable content and assets.
export async function shopFixture() {
  return loadContent(
    [
      {
        schema_version: '1.0',
        content_version: 'shop-test-1',
        id: 'shop',
        name: 'Shop',
        map: { width: 24, height: 10, floorTile: 0, wallTile: 1 },
        anchors: { entrance: [20, 7] },
        entities: [
          {
            id: 'merchant',
            name: 'Merchant',
            character: 'f1',
            position: [20, 5],
            interactionOffsets: [[0, 2]],
          },
        ],
      },
    ],
    {
      schema_version: '1.0',
      content_version: 'shop-test-1',
      start: { scene: 'shop', anchor: 'entrance' },
      vars: {},
      interactions: { merchant: { text: 'Welcome', choices: [] } },
      items: ['spring-water', 'amber-reserve'].map((id) => ({
        id,
        name: id,
        image: 'assets/test/item.png',
        category: 'drink',
        quality: 'ordinary',
        description: id,
      })),
      shops: {
        merchant: {
          name: 'Shop',
          restock: { intervalSeconds: 86400 },
          offers: [
            { item: 'spring-water', buySeconds: 120, sellSeconds: 60, stock: 30 },
            { item: 'amber-reserve', buySeconds: 1800, sellSeconds: 900, stock: 30 },
          ],
        },
      },
    },
  );
}
