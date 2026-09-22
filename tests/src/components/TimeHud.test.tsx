import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TimeHud from '../../../src/components/TimeHud';

jest.mock('../../../src/components/TimeHud.css', () => ({}));

test('HUD displays separate clocks, midnight and overdraft', () => {
  const initial = renderToStaticMarkup(<TimeHud balance={25200} storyTime={64800} />);
  expect(initial).toContain('18:00');
  expect(initial).toContain('6月1日 · 星期一');
  expect(initial).toContain('7:00:00');
  const midnight = renderToStaticMarkup(<TimeHud balance={-1800} storyTime={86400} />);
  expect(midnight).toContain('00:00');
  expect(midnight).toContain('6月2日 · 星期二');
  expect(midnight).toContain('-0:30:00');
  expect(midnight).toContain('透支');
});
