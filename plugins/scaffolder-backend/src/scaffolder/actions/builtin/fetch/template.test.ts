/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import os from 'os';
import { join as joinPath } from 'path';
import fs from 'fs-extra';
import mockFs from 'mock-fs';
import {
  getVoidLogger,
  resolvePackagePath,
  UrlReader,
} from '@backstage/backend-common';
import { ScmIntegrations } from '@backstage/integration';
import { PassThrough } from 'stream';
import { fetchContents } from './helpers';
import { ActionContext, TemplateAction } from '../../types';
import { createFetchTemplateAction } from './template';

jest.mock('./helpers', () => ({
  fetchContents: jest.fn(),
}));

type FetchTemplateInput = ReturnType<
  typeof createFetchTemplateAction
> extends TemplateAction<infer U>
  ? U
  : never;

const realFiles = Object.fromEntries(
  [
    resolvePackagePath(
      '@backstage/plugin-scaffolder-backend',
      'assets',
      'nunjucks.js.txt',
    ),
  ].map(k => [k, mockFs.load(k)]),
);

const aBinaryFile = fs.readFileSync(
  resolvePackagePath(
    '@backstage/plugin-scaffolder-backend',
    'fixtures/test-nested-template/public/react-logo192.png',
  ),
);

const mockFetchContents = fetchContents as jest.MockedFunction<
  typeof fetchContents
>;

describe('fetch:template', () => {
  let action: TemplateAction<any>;

  const workspacePath = os.tmpdir();
  const createTemporaryDirectory: jest.MockedFunction<
    ActionContext<FetchTemplateInput>['createTemporaryDirectory']
  > = jest.fn(() =>
    Promise.resolve(
      joinPath(workspacePath, `${createTemporaryDirectory.mock.calls.length}`),
    ),
  );

  const logger = getVoidLogger();

  const mockContext = (inputPatch: Partial<FetchTemplateInput> = {}) => ({
    templateInfo: {
      baseUrl: 'base-url',
      entityRef: 'template:default/test-template',
    },
    input: {
      url: './skeleton',
      targetPath: './target',
      values: {
        test: 'value',
      },
      ...inputPatch,
    },
    output: jest.fn(),
    logStream: new PassThrough(),
    logger,
    workspacePath,
    createTemporaryDirectory,
  });

  beforeEach(() => {
    mockFs({
      ...realFiles,
    });

    action = createFetchTemplateAction({
      reader: Symbol('UrlReader') as unknown as UrlReader,
      integrations: Symbol('Integrations') as unknown as ScmIntegrations,
    });
  });

  afterEach(() => {
    mockFs.restore();
  });

  it(`returns a TemplateAction with the id 'fetch:template'`, () => {
    expect(action.id).toEqual('fetch:template');
  });

  describe('handler', () => {
    it('throws if output directory is outside the workspace', async () => {
      await expect(() =>
        action.handler(mockContext({ targetPath: '../' })),
      ).rejects.toThrow(
        /relative path is not allowed to refer to a directory outside its parent/i,
      );
    });

    it('throws if copyWithoutRender parameter is not an array', async () => {
      await expect(() =>
        action.handler(
          mockContext({ copyWithoutRender: 'abc' as unknown as string[] }),
        ),
      ).rejects.toThrow(
        /copyWithoutRender\/copyWithoutTemplating must be an array/i,
      );
    });

    it('throws if both copyWithoutRender and copyWithoutTemplating are used', async () => {
      await expect(() =>
        action.handler(
          mockContext({
            copyWithoutRender: 'abc' as unknown as string[],
            copyWithoutTemplating: 'def' as unknown as string[],
          }),
        ),
      ).rejects.toThrow(
        /copyWithoutRender and copyWithoutTemplating can not be used at the same time/i,
      );
    });

    it('throws if copyWithoutRender is used with extension', async () => {
      await expect(() =>
        action.handler(
          mockContext({
            copyWithoutRender: ['abc'],
            templateFileExtension: true,
          }),
        ),
      ).rejects.toThrow(
        /input extension incompatible with copyWithoutRender\/copyWithoutTemplating and cookiecutterCompat/,
      );
    });

    it('throws if cookiecutterCompat is used with extension', async () => {
      await expect(() =>
        action.handler(
          mockContext({
            cookiecutterCompat: true,
            templateFileExtension: true,
          }),
        ),
      ).rejects.toThrow(
        /input extension incompatible with copyWithoutRender\/copyWithoutTemplating and cookiecutterCompat/,
      );
    });

    describe('with optional directories / files', () => {
      let context: ActionContext<FetchTemplateInput>;

      beforeEach(async () => {
        context = mockContext({
          values: {
            showDummyFile: false,
            skipRootDirectory: true,
            skipSubdirectory: true,
            skipMultiplesDirectories: true,
            skipFileInsideDirectory: true,
          },
        });

        mockFetchContents.mockImplementation(({ outputPath }) => {
          mockFs({
            ...realFiles,
            [outputPath]: {
              '{% if values.showDummyFile %}dummy-file.txt{% else %}{% endif %}':
                'dummy file',
              '${{ "dummy-file2.txt" if values.showDummyFile else "" }}':
                'some dummy file',
              '${{ "dummy-dir" if not values.skipRootDirectory else "" }}': {
                'file.txt': 'file inside optional directory',
                subdir: {
                  '${{ "dummy-subdir" if not values.skipSubdirectory else "" }}':
                    'file inside optional subdirectory',
                },
              },
              subdir2: {
                '${{ "dummy-subdir" if not values.skipMultiplesDirectories else "" }}':
                  {
                    '${{ "dummy-subdir" if not values.skipMultiplesDirectories else "" }}':
                      {
                        'multipleDirectorySkippedFile.txt':
                          'file inside multiple optional subdirectories',
                      },
                  },
              },
              subdir3: {
                '${{ "fileSkippedInsideDirectory.txt" if not values.skipFileInsideDirectory else "" }}':
                  'skipped file inside directory',
              },
            },
          });

          return Promise.resolve();
        });

        await action.handler(context);
      });

      it('skips empty filename', async () => {
        await expect(
          fs.pathExists(`${workspacePath}/target/dummy-file.txt`),
        ).resolves.toEqual(false);
      });

      it('skips empty filename syntax #2', async () => {
        await expect(
          fs.pathExists(`${workspacePath}/target/dummy-file2.txt`),
        ).resolves.toEqual(false);
      });

      it('skips empty directory', async () => {
        await expect(
          fs.pathExists(`${workspacePath}/target/dummy-dir/dummy-file3.txt`),
        ).resolves.toEqual(false);
      });

      it('skips empty filename inside directory', async () => {
        await expect(
          fs.pathExists(
            `${workspacePath}/target/subdir3/fileSkippedInsideDirectory.txt`,
          ),
        ).resolves.toEqual(false);
      });

      it('skips content of empty subdirectory', async () => {
        await expect(
          fs.pathExists(
            `${workspacePath}/target/subdir2/multipleDirectorySkippedFile.txt`,
          ),
        ).resolves.toEqual(false);

        await expect(
          fs.pathExists(
            `${workspacePath}/target/subdir2/dummy-subdir/dummy-subdir/multipleDirectorySkippedFile.txt`,
          ),
        ).resolves.toEqual(false);
      });
    });

    describe('with valid input', () => {
      let context: ActionContext<FetchTemplateInput>;

      beforeEach(async () => {
        context = mockContext({
          values: {
            name: 'test-project',
            count: 1234,
            itemList: ['first', 'second', 'third'],
            showDummyFile: false,
          },
        });

        mockFetchContents.mockImplementation(({ outputPath }) => {
          mockFs({
            ...realFiles,
            [outputPath]: {
              'an-executable.sh': mockFs.file({
                content: '#!/usr/bin/env bash',
                mode: parseInt('100755', 8),
              }),
              'empty-dir-${{ values.count }}': {},
              'static.txt': 'static content',
              '${{ values.name }}.txt': 'static content',
              subdir: {
                'templated-content.txt':
                  '${{ values.name }}: ${{ values.count }}',
              },
              '.${{ values.name }}': '${{ values.itemList | dump }}',
              'a-binary-file.png': aBinaryFile,
              symlink: mockFs.symlink({
                path: 'a-binary-file.png',
              }),
              brokenSymlink: mockFs.symlink({
                path: './not-a-real-file.txt',
              }),
            },
          });

          return Promise.resolve();
        });

        await action.handler(context);
      });

      it('uses fetchContents to retrieve the template content', () => {
        expect(mockFetchContents).toHaveBeenCalledWith(
          expect.objectContaining({
            baseUrl: context.templateInfo?.baseUrl,
            fetchUrl: context.input.url,
          }),
        );
      });

      it('copies files with no templating in names or content successfully', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/static.txt`, 'utf-8'),
        ).resolves.toEqual('static content');
      });

      it('copies files with templated names successfully', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/test-project.txt`, 'utf-8'),
        ).resolves.toEqual('static content');
      });

      it('copies files with templated content successfully', async () => {
        await expect(
          fs.readFile(
            `${workspacePath}/target/subdir/templated-content.txt`,
            'utf-8',
          ),
        ).resolves.toEqual('test-project: 1234');
      });

      it('processes dotfiles', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/.test-project`, 'utf-8'),
        ).resolves.toEqual('["first","second","third"]');
      });

      it('copies empty directories', async () => {
        await expect(
          fs.readdir(`${workspacePath}/target/empty-dir-1234`, 'utf-8'),
        ).resolves.toEqual([]);
      });

      it('copies binary files as-is without processing them', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/a-binary-file.png`),
        ).resolves.toEqual(aBinaryFile);
      });
      it('copies files and maintains the original file permissions', async () => {
        await expect(
          fs
            .stat(`${workspacePath}/target/an-executable.sh`)
            .then(fObj => fObj.mode),
        ).resolves.toEqual(parseInt('100755', 8));
      });
      it('copies file symlinks as-is without processing them', async () => {
        await expect(
          fs
            .lstat(`${workspacePath}/target/symlink`)
            .then(i => i.isSymbolicLink()),
        ).resolves.toBe(true);

        await expect(
          fs.realpath(`${workspacePath}/target/symlink`),
        ).resolves.toBe(joinPath(workspacePath, 'target', 'a-binary-file.png'));
      });
      it('copies broken symlinks as-is without processing them', async () => {
        await expect(
          fs
            .lstat(`${workspacePath}/target/brokenSymlink`)
            .then(i => i.isSymbolicLink()),
        ).resolves.toBe(true);

        await expect(
          fs.readlink(`${workspacePath}/target/brokenSymlink`),
        ).resolves.toEqual('./not-a-real-file.txt');
      });
    });
  });

  describe('copyWithoutRender', () => {
    let context: ActionContext<FetchTemplateInput>;

    beforeEach(async () => {
      context = mockContext({
        values: {
          name: 'test-project',
          count: 1234,
        },
        copyWithoutRender: ['.unprocessed'],
      });

      mockFetchContents.mockImplementation(({ outputPath }) => {
        mockFs({
          ...realFiles,
          [outputPath]: {
            processed: {
              'templated-content-${{ values.name }}.txt': '${{ values.count }}',
            },
            '.unprocessed': {
              'templated-content-${{ values.name }}.txt': '${{ values.count }}',
            },
          },
        });

        return Promise.resolve();
      });

      await action.handler(context);
    });

    it('ignores template syntax in files matched in copyWithoutRender', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/.unprocessed/templated-content-\${{ values.name }}.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('${{ values.count }}');
    });

    it('processes files not matched in copyWithoutRender', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/processed/templated-content-test-project.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('1234');
    });
  });

  describe('copyWithoutTemplating', () => {
    let context: ActionContext<FetchTemplateInput>;

    beforeEach(async () => {
      context = mockContext({
        values: {
          name: 'test-project',
          count: 1234,
        },
        copyWithoutTemplating: ['.unprocessed'],
      });

      mockFetchContents.mockImplementation(({ outputPath }) => {
        mockFs({
          ...realFiles,
          [outputPath]: {
            processed: {
              'templated-content-${{ values.name }}.txt': '${{ values.count }}',
            },
            '.unprocessed': {
              'templated-content-${{ values.name }}.txt': '${{ values.count }}',
            },
          },
        });

        return Promise.resolve();
      });

      await action.handler(context);
    });

    it('renders path template and ignores content template in files matched in copyWithoutTemplating', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/.unprocessed/templated-content-test-project.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('${{ values.count }}');
    });

    it('processes files not matched in copyWithoutTemplating', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/processed/templated-content-test-project.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('1234');
    });
  });

  describe('cookiecutter compatibility mode', () => {
    let context: ActionContext<FetchTemplateInput>;

    beforeEach(async () => {
      context = mockContext({
        values: {
          name: 'test-project',
          count: 1234,
          itemList: ['first', 'second', 'third'],
        },
        cookiecutterCompat: true,
      });

      mockFetchContents.mockImplementation(({ outputPath }) => {
        mockFs({
          ...realFiles,
          [outputPath]: {
            '{{ cookiecutter.name }}.txt': 'static content',
            subdir: {
              'templated-content.txt':
                '{{ cookiecutter.name }}: {{ cookiecutter.count }}',
            },
            '{{ cookiecutter.name }}.json':
              '{{ cookiecutter.itemList | jsonify }}',
          },
        });

        return Promise.resolve();
      });

      await action.handler(context);
    });

    it('copies files with cookiecutter-style templated names successfully', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.txt`, 'utf-8'),
      ).resolves.toEqual('static content');
    });

    it('copies files with cookiecutter-style templated content successfully', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/subdir/templated-content.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('test-project: 1234');
    });

    it('includes the jsonify filter', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.json`, 'utf-8'),
      ).resolves.toEqual('["first","second","third"]');
    });
  });

  describe('with extension=true', () => {
    let context: ActionContext<FetchTemplateInput>;

    beforeEach(async () => {
      context = mockContext({
        values: {
          name: 'test-project',
          count: 1234,
          itemList: ['first', 'second', 'third'],
        },
        templateFileExtension: true,
      });

      mockFetchContents.mockImplementation(({ outputPath }) => {
        mockFs({
          ...realFiles,
          [outputPath]: {
            'empty-dir-${{ values.count }}': {},
            'static.txt': 'static content',
            '${{ values.name }}.txt': 'static content',
            '${{ values.name }}.txt.jinja2':
              '${{ values.name }}: ${{ values.count }}',
            subdir: {
              'templated-content.txt.njk':
                '${{ values.name }}: ${{ values.count }}',
            },
            '.${{ values.name }}.njk': '${{ values.itemList | dump }}',
            'a-binary-file.png': aBinaryFile,
          },
        });

        return Promise.resolve();
      });

      await action.handler(context);
    });

    it('copies files with no templating in names or content successfully', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/static.txt`, 'utf-8'),
      ).resolves.toEqual('static content');
    });

    it('copies files with templated names successfully', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.txt`, 'utf-8'),
      ).resolves.toEqual('static content');
    });

    it('copies jinja2 files with templated names successfully', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.txt.jinja2`, 'utf-8'),
      ).resolves.toEqual('${{ values.name }}: ${{ values.count }}');
    });

    it('copies files with templated content successfully', async () => {
      await expect(
        fs.readFile(
          `${workspacePath}/target/subdir/templated-content.txt`,
          'utf-8',
        ),
      ).resolves.toEqual('test-project: 1234');
    });

    it('processes dotfiles', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/.test-project`, 'utf-8'),
      ).resolves.toEqual('["first","second","third"]');
    });

    it('copies empty directories', async () => {
      await expect(
        fs.readdir(`${workspacePath}/target/empty-dir-1234`, 'utf-8'),
      ).resolves.toEqual([]);
    });

    it('copies binary files as-is without processing them', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/a-binary-file.png`),
      ).resolves.toEqual(aBinaryFile);
    });
  });

  describe('with specified .jinja2 extension', () => {
    let context: ActionContext<FetchTemplateInput>;

    beforeEach(async () => {
      context = mockContext({
        templateFileExtension: '.jinja2',
        values: {
          name: 'test-project',
          count: 1234,
        },
      });

      mockFetchContents.mockImplementation(({ outputPath }) => {
        mockFs({
          ...realFiles,
          [outputPath]: {
            '${{ values.name }}.njk': '${{ values.name }}: ${{ values.count }}',
            '${{ values.name }}.txt.jinja2':
              '${{ values.name }}: ${{ values.count }}',
          },
        });

        return Promise.resolve();
      });

      await action.handler(context);
    });

    it('does not process .njk files', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.njk`, 'utf-8'),
      ).resolves.toEqual('${{ values.name }}: ${{ values.count }}');
    });

    it('does process .jinja2 files', async () => {
      await expect(
        fs.readFile(`${workspacePath}/target/test-project.txt`, 'utf-8'),
      ).resolves.toEqual('test-project: 1234');
    });
  });
});
