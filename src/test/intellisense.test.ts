import * as assert from 'assert';
import { analyze, scanOpenTag } from '../modules/IntellisenseSupport/parsing/TagContext';
import { elContextAt, extractRefs, openElIndex } from '../modules/IntellisenseSupport/parsing/ElParser';
import { BeanRegistry } from '../modules/AI/BeanRegistry';
import { JavaClassIndex } from '../modules/IntellisenseSupport/java/JavaClassIndex';
import { ScopeResolver } from '../modules/IntellisenseSupport/parsing/ScopeResolver';

suite('Faces Intellisense & EL Test Suite', () => {
    test('TagContext: detecta completion de tag name', () => {
        const res = analyze('<p:dataTab');
        assert.strictEqual(res.kind, 'tagName');
        if (res.kind === 'tagName') {
            assert.strictEqual(res.prefix, 'p');
            assert.strictEqual(res.partial, 'dataTab');
        }
    });

    test('TagContext: detecta completion de atributos y atributos usados', () => {
        const res = analyze('<p:dataTable var="item" paginator="true" ');
        assert.strictEqual(res.kind, 'attrName');
        if (res.kind === 'attrName') {
            assert.strictEqual(res.prefix, 'p');
            assert.strictEqual(res.component, 'dataTable');
            assert.ok(res.used.has('var'));
            assert.ok(res.used.has('paginator'));
            assert.strictEqual(res.used.has('value'), false);
        }
    });

    test('TagContext: no interfiere dentro de expresiones EL', () => {
        const res = analyze('<p:inputText value="#{clienteBean.nombre');
        assert.strictEqual(res.kind, 'el');
    });

    test('ElParser: detecta contexto de raíz EL', () => {
        const res = elContextAt('<h:outputText value="#{clie');
        assert.ok(res);
        assert.strictEqual(res?.kind, 'root');
        if (res?.kind === 'root') {
            assert.strictEqual(res.partial, 'clie');
        }
    });

    test('ElParser: detecta contexto de miembro EL encadenado', () => {
        const res = elContextAt('<h:outputText value="#{clienteBean.usuario.dir');
        assert.ok(res);
        assert.strictEqual(res?.kind, 'member');
        if (res?.kind === 'member') {
            assert.strictEqual(res.partial, 'dir');
            assert.strictEqual(res.segments.length, 2);
            assert.strictEqual(res.segments[0].name, 'clienteBean');
            assert.strictEqual(res.segments[1].name, 'usuario');
        }
    });

    test('ElParser: extractRefs soporta llamadas y ternarios', () => {
        const text = 'clienteBean.isActive() ? clienteBean.usuario.nombre : "invitado"';
        const refs = extractRefs(text, 0, text.length);
        assert.strictEqual(refs.length, 2);
        assert.strictEqual(refs[0].segments[0].name, 'clienteBean');
        assert.strictEqual(refs[0].segments[0].call, true);
        assert.strictEqual(refs[1].segments[0].name, 'clienteBean');
        assert.strictEqual(refs[1].segments[1].name, 'usuario');
        assert.strictEqual(refs[1].segments[2].name, 'nombre');
    });

    test('ScopeResolver: detecta variables de p:dataTable y ui:param', () => {
        const beanRegistry = new BeanRegistry();
        const classIndex = new JavaClassIndex(beanRegistry);
        const scopeResolver = new ScopeResolver(classIndex);

        const xhtmlFragment = `
            <ui:composition>
                <ui:param name="usuarioActual" value="Usuario"/>
                <p:dataTable var="item" value="#{listaUsuarios}">
                    <p:column>
        `;

        const scopes = scopeResolver.resolveScopeVariables(xhtmlFragment);
        assert.ok(scopes.has('usuarioActual'));
        assert.ok(scopes.has('item'));
    });

    test('ScopeResolver: detecta variables en f:selectItems dentro de p:selectOneMenu', () => {
        const beanRegistry = new BeanRegistry();
        const classIndex = new JavaClassIndex(beanRegistry);
        const scopeResolver = new ScopeResolver(classIndex);

        const xhtmlFragment = `
            <p:dataTable var="obj" value="#{infraccionesController.view.articulosFiltrados}">
                <p:column>
                    <p:selectOneMenu value="#{obj.tabuladorSeleccionado}">
                        <f:selectItems value="#{infraccionesController.view.listTabuladores}" var="tabulador"
                                itemLabel="#{tabulador.dsarticulo}" itemValue="#{tabulador}"/>
                    </p:selectOneMenu>
                </p:column>
            </p:dataTable>
        `;

        const targetPos = xhtmlFragment.indexOf('tabulador.dsarticulo');
        const textBefore = xhtmlFragment.substring(0, targetPos);
        const scopes = scopeResolver.resolveScopeVariables(textBefore, xhtmlFragment, targetPos);

        assert.ok(scopes.has('obj'), 'Debe detectar var de p:dataTable');
        assert.ok(scopes.has('tabulador'), 'Debe detectar var de f:selectItems');
    });
});

