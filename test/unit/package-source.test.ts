/** source 解析、身份归一、公开性白名单——纯函数，不碰文件系统。 */
import { describe, expect, it } from 'vitest';

import { entrySource, isPublicSource, packageIdentity, parseSource } from '../../src/package-source.js';

describe('parseSource', () => {
  it('识别 npm 源，剥掉版本与 tag', () => {
    expect(parseSource('npm:pi-code')).toEqual({ type: 'npm', name: 'pi-code' });
    expect(parseSource('npm:pi-code@1.2.3')).toEqual({ type: 'npm', name: 'pi-code' });
    expect(parseSource('npm:@scope/pkg@latest')).toEqual({ type: 'npm', name: '@scope/pkg' });
    expect(parseSource('npm:@scope/pkg')).toEqual({ type: 'npm', name: '@scope/pkg' });
  });

  it('识别 SSH / HTTPS / 裸域名的 git 源', () => {
    expect(parseSource('git@gitlab.example.com:team/repo.git')).toEqual({
      type: 'git',
      host: 'gitlab.example.com',
      path: 'team/repo',
    });
    expect(parseSource('git:https://github.com/obra/superpowers')).toEqual({
      type: 'git',
      host: 'github.com',
      path: 'obra/superpowers',
    });
    expect(parseSource('git:github.com/obra/superpowers')).toEqual({
      type: 'git',
      host: 'github.com',
      path: 'obra/superpowers',
    });
  });

  it('剥掉 #ref 片段与结尾斜杠', () => {
    expect(parseSource('git:https://github.com/obra/superpowers.git#v1.0.0')).toEqual({
      type: 'git',
      host: 'github.com',
      path: 'obra/superpowers',
    });
  });

  it('不是已知协议的当作本地路径', () => {
    expect(parseSource('./local-dir').type).toBe('local');
    expect(parseSource('/abs/path').type).toBe('local');
  });
});

describe('packageIdentity', () => {
  it('把同一个 GitHub 仓库的 SSH 与 HTTPS 写法归一', () => {
    expect(packageIdentity('git:git@github.com:obra/superpowers.git'))
      .toBe(packageIdentity('git:https://github.com/obra/superpowers'));
    expect(packageIdentity('git:github.com/obra/superpowers')).toBe('git:github.com/obra/superpowers');
  });

  it('npm 身份忽略版本', () => {
    expect(packageIdentity('npm:pi-code@1.2.3')).toBe('npm:pi-code');
    expect(packageIdentity('npm:@scope/pkg@latest')).toBe('npm:@scope/pkg');
  });

  it('对象形式的条目先取 source 再判身份', () => {
    const entry = { source: 'npm:pi-code', extensions: ['!extensions/mcp/**'] };
    expect(packageIdentity(entrySource(entry))).toBe('npm:pi-code');
  });
});

describe('entrySource', () => {
  it('字符串与对象两种形态都能取到源', () => {
    expect(entrySource('npm:a')).toBe('npm:a');
    expect(entrySource({ source: 'npm:b' })).toBe('npm:b');
  });
});

describe('isPublicSource 白名单', () => {
  it('放行 npm 与 github.com', () => {
    expect(isPublicSource('npm:pi-code')).toBe(true);
    expect(isPublicSource('git:github.com/obra/superpowers')).toBe(true);
    expect(isPublicSource('git:git@github.com:obra/superpowers.git')).toBe(true);
    expect(isPublicSource('git:https://www.github.com/obra/superpowers')).toBe(true);
  });

  it('拒绝内网 GitLab 与本地路径', () => {
    expect(isPublicSource('git:git@gitlab.basemind.com:team/repo.git')).toBe(false);
    expect(isPublicSource('git:https://gitlab.basemind.com/team/repo')).toBe(false);
    expect(isPublicSource('/Users/someone/secret')).toBe(false);
  });

  it('未知主机默认拒绝——白名单的意义就在这里', () => {
    expect(isPublicSource('git:git@git.example.internal:team/repo.git')).toBe(false);
  });
});
