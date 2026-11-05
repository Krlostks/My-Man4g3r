import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MavenManager } from '../modules/maven/MavenManager';
import { ServerManager } from '../modules/server/ServerManager';

suite('MavenManager incremental class sync', () => {
    let root: string;
    let manager: MavenManager;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm43-sync-'));
        manager = new MavenManager({} as ServerManager);
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function project() {
        return { name: 'sync-test', rootPath: root, warName: 'sync-test' };
    }

    function sourcePath(relativePath: string): string {
        return path.join(root, 'target', 'classes', ...relativePath.split('/'));
    }

    function destinationPath(relativePath: string): string {
        return path.join(root, 'target', 'sync-test', 'WEB-INF', 'classes', ...relativePath.split('/'));
    }

    test('copies changed classes atomically and includes inner classes', async () => {
        fs.mkdirSync(path.dirname(sourcePath('sample/Foo.class')), { recursive: true });
        fs.writeFileSync(sourcePath('sample/Foo.class'), Buffer.from([1, 2, 3]));
        fs.writeFileSync(sourcePath('sample/Foo$1.class'), Buffer.from([4, 5, 6]));

        const result = await manager.syncExplodedClasses(project());

        assert.ok(result);
        assert.deepStrictEqual(
            result?.changed.map(c => c.className),
            ['sample.Foo', 'sample.Foo$1']
        );
        assert.ok(result?.changed.every(c => /^[a-f0-9]{64}$/.test(c.hash)));
        assert.deepStrictEqual(fs.readFileSync(destinationPath('sample/Foo.class')), Buffer.from([1, 2, 3]));
        assert.deepStrictEqual(fs.readFileSync(destinationPath('sample/Foo$1.class')), Buffer.from([4, 5, 6]));
        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(destinationPath('sample/Foo.class'))).filter(n => n.includes('.mm43tmp-')),
            []
        );
    });

    test('does not report or rewrite identical files on a repeated sync', async () => {
        fs.mkdirSync(path.dirname(sourcePath('sample/Foo.class')), { recursive: true });
        fs.writeFileSync(sourcePath('sample/Foo.class'), Buffer.from([1, 2, 3]));

        const first = await manager.syncExplodedClasses(project());
        const destination = destinationPath('sample/Foo.class');
        const originalMtime = fs.statSync(destination).mtimeMs;
        const second = await manager.syncExplodedClasses(project());

        assert.strictEqual(first?.changed.length, 1);
        assert.deepStrictEqual(second, { changed: [], removed: [] });
        assert.strictEqual(fs.statSync(destination).mtimeMs, originalMtime);
    });

    test('reports only removed class files using relative paths', async () => {
        fs.mkdirSync(path.dirname(sourcePath('sample/Keep.class')), { recursive: true });
        fs.writeFileSync(sourcePath('sample/Keep.class'), Buffer.from([1]));
        fs.writeFileSync(sourcePath('sample/Remove$1.class'), Buffer.from([2]));
        await manager.syncExplodedClasses(project());

        fs.rmSync(sourcePath('sample/Remove$1.class'));
        const result = await manager.syncExplodedClasses(project());

        assert.deepStrictEqual(result?.removed, ['sample/Remove$1.class']);
        assert.deepStrictEqual(result?.changed, []);
        assert.strictEqual(fs.existsSync(destinationPath('sample/Remove$1.class')), false);
        assert.strictEqual(fs.existsSync(destinationPath('sample/Keep.class')), true);
    });

    test('handles overlapping sync requests without partial writes', async () => {
        fs.mkdirSync(path.dirname(sourcePath('sample/Foo.class')), { recursive: true });
        const bytecode = Buffer.alloc(256 * 1024, 0x5a);
        fs.writeFileSync(sourcePath('sample/Foo.class'), bytecode);

        const results = await Promise.all([
            manager.syncExplodedClasses(project()),
            manager.syncExplodedClasses(project()),
        ]);

        assert.deepStrictEqual(fs.readFileSync(destinationPath('sample/Foo.class')), bytecode);
        assert.strictEqual(results.filter(r => r?.changed.length === 1).length, 1);
        assert.strictEqual(results.filter(r => r?.changed.length === 0).length, 1);
    });

    test('returns null when the compiled classes directory is missing', async () => {
        assert.strictEqual(await manager.syncExplodedClasses(project()), null);
    });
});
