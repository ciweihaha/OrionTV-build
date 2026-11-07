import * as React from 'react';
import renderer, { act } from 'react-test-renderer';

import {ThemedText} from '../ThemedText';

it(`renders correctly`, () => {
  // React 19 下 create() 不包 act 会异步渲染：toJSON() 立刻取是 null，
  // 渲染拖到测试环境拆除后才跑（useWindowDimensions 的懒加载随之炸掉）
  let root: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(<ThemedText>Snapshot test!</ThemedText>);
  });

  expect(root.toJSON()).toMatchSnapshot();
});
