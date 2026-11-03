import * as fs from 'fs';
import * as path from 'path';
import { BeanRegistry } from '../../AI/BeanRegistry';
import { Logger } from '../../logger/Logger';

export interface JavaField {
    name: string;
    type: string;
    isPublic: boolean;
}

export interface JavaParam {
    name: string;
    type: string;
}

export interface JavaMethod {
    name: string;
    returnType: string;
    params: JavaParam[];
    signature: string;
    isGetter: boolean;
    isSetter: boolean;
    isBooleanGetter: boolean;
}

export interface ElProperty {
    name: string;
    type: string;
    readable: boolean;
    writable: boolean;
    source: 'field' | 'getter' | 'lombok';
    field?: JavaField;
    getter?: JavaMethod;
    setter?: JavaMethod;
    originClass?: string;
}

export interface JavaClassInfo {
    className: string;
    filePath: string;
    superClass?: string;
    interfaces: string[];
    fields: Map<string, JavaField>;
    methods: Map<string, JavaMethod[]>;
    properties: Map<string, ElProperty>;
    lastModified: number;
}

export class JavaClassIndex {
    private cache = new Map<string, JavaClassInfo>();

    constructor(private readonly beanRegistry: BeanRegistry) {}

    /**
     * Obtiene o parsea la información de la clase a partir de la ruta del archivo .java.
     * Utiliza cache basada en mtimeMs.
     */
    getClassInfo(filePath: string): JavaClassInfo | undefined {
        try {
            if (!fs.existsSync(filePath)) {
                return undefined;
            }
            const stat = fs.statSync(filePath);
            const cached = this.cache.get(filePath);
            if (cached && cached.lastModified === stat.mtimeMs) {
                return cached;
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const info = this.parseJavaContent(filePath, content, stat.mtimeMs);
            this.cache.set(filePath, info);
            return info;
        } catch (err) {
            Logger.warn('XHTML', `Error analizando clase Java en ${filePath}: ${String(err)}`);
            return undefined;
        }
    }

    /**
     * Obtiene la información de una clase por su nombre simple (ej. "ClienteBean").
     */
    getClassInfoByName(className: string): JavaClassInfo | undefined {
        const filePath = this.beanRegistry.getClassFile(className);
        if (!filePath) {
            return undefined;
        }
        return this.getClassInfo(filePath);
    }

    /**
     * Resuelve los miembros y propiedades completas de una clase, incluyendo herencia (extends).
     */
    getResolvedClassInfo(filePath: string, visited = new Set<string>()): {
        info: JavaClassInfo;
        allProperties: Map<string, ElProperty>;
        allMethods: Map<string, JavaMethod[]>;
        allFields: Map<string, JavaField>;
    } | undefined {
        const info = this.getClassInfo(filePath);
        if (!info) {
            return undefined;
        }

        if (visited.has(info.className)) {
            // Prevenir ciclos de herencia
            return {
                info,
                allProperties: new Map(info.properties),
                allMethods: new Map(info.methods),
                allFields: new Map(info.fields)
            };
        }
        visited.add(info.className);

        const allProperties = new Map<string, ElProperty>();
        const allMethods = new Map<string, JavaMethod[]>();
        const allFields = new Map<string, JavaField>();

        // 1. Si tiene superclase, heredar primero sus miembros
        if (info.superClass) {
            const superFile = this.beanRegistry.getClassFile(info.superClass);
            if (superFile) {
                const superResolved = this.getResolvedClassInfo(superFile, visited);
                if (superResolved) {
                    for (const [k, v] of superResolved.allProperties) {
                        allProperties.set(k, v);
                    }
                    for (const [k, v] of superResolved.allMethods) {
                        allMethods.set(k, [...v]);
                    }
                    for (const [k, v] of superResolved.allFields) {
                        allFields.set(k, v);
                    }
                }
            }
        }

        // 2. Sobrescribir / agregar miembros directos de la clase
        for (const [k, v] of info.properties) {
            allProperties.set(k, v);
        }
        for (const [k, v] of info.methods) {
            const existing = allMethods.get(k) || [];
            allMethods.set(k, [...existing, ...v]);
        }
        for (const [k, v] of info.fields) {
            allFields.set(k, v);
        }

        return { info, allProperties, allMethods, allFields };
    }

    /**
     * Resuelve una cadena de navegación EL (ej. ['clienteBean', 'usuario', 'direccion', 'calle']).
     * Devuelve el tipo y propiedad resuelta en cada paso.
     */
    resolveChain(
        rootClassNameOrBean: string,
        parts: string[],
        scopeVariables?: Map<string, string>
    ): {
        targetProperty?: ElProperty;
        targetMethod?: JavaMethod;
        targetType?: string;
        declaringClass?: string;
    } | undefined {
        if (parts.length === 0) {
            return undefined;
        }

        let currentClassName: string | undefined;

        // Verificar primero si el primer segmento es una variable de scope (ej. var="item")
        const root = parts[0];
        if (scopeVariables && scopeVariables.has(root)) {
            currentClassName = this.cleanType(scopeVariables.get(root)!);
        } else {
            // Resolver como bean CDI
            const bean = this.beanRegistry.resolve(root);
            if (bean) {
                currentClassName = bean.className;
            } else {
                // Probar si pasaron el nombre de la clase directamente (solo si existe en el registro)
                const clean = this.cleanType(root);
                if (this.beanRegistry.getClassFile(clean)) {
                    currentClassName = clean;
                }
            }
        }

        if (!currentClassName) {
            return undefined;
        }

        if (parts.length === 1) {
            return {
                targetType: currentClassName,
                declaringClass: currentClassName
            };
        }

        for (let i = 1; i < parts.length; i++) {
            const seg = parts[i];
            const file = this.beanRegistry.getClassFile(currentClassName);
            if (!file) {
                return undefined;
            }

            const resolved = this.getResolvedClassInfo(file);
            if (!resolved) {
                return undefined;
            }

            const isLast = i === parts.length - 1;

            // 1. Buscar en propiedades EL (getters / Lombok / fields)
            const prop = resolved.allProperties.get(seg);
            if (prop) {
                if (isLast) {
                    return {
                        targetProperty: prop,
                        targetType: prop.type,
                        declaringClass: prop.originClass || resolved.info.className
                    };
                }
                currentClassName = this.unwrapGenericType(prop.type);
                continue;
            }

            // 2. Buscar en métodos
            const methods = resolved.allMethods.get(seg);
            if (methods && methods.length > 0) {
                const meth = methods[0];
                if (isLast) {
                    return {
                        targetMethod: meth,
                        targetType: meth.returnType,
                        declaringClass: resolved.info.className
                    };
                }
                currentClassName = this.unwrapGenericType(meth.returnType);
                continue;
            }

            // 3. Buscar en campos directos
            const field = resolved.allFields.get(seg);
            if (field) {
                if (isLast) {
                    return {
                        targetType: field.type,
                        declaringClass: resolved.info.className
                    };
                }
                currentClassName = this.unwrapGenericType(field.type);
                continue;
            }

            return undefined;
        }

        return undefined;
    }

    /**
     * Limpia un tipo Java de genéricos y arrays (ej. "List<Usuario>" → "Usuario", "String[]" → "String").
     */
    cleanType(rawType: string): string {
        const unwrapped = this.unwrapGenericType(rawType);
        // Remover paquete si viene calificado (ej. com.sigaf.model.Tabulador -> Tabulador)
        const simple = unwrapped.split('.').pop() || unwrapped;
        return simple.trim();
    }

    /**
     * Extrae el tipo contenido en colecciones genéricas como List<T>, Set<T>, Map<K,V>, Optional<T>.
     */
    unwrapGenericType(typeStr: string): string {
        let t = typeStr.trim();
        // Array: Tipo[] -> Tipo
        t = t.replace(/\[\s*\]$/, '');

        // Map<K, V> -> V (en EL map['clave'] o map.clave da el valor V)
        const mapMatch = /^(?:java\.util\.)?(?:Map|HashMap|LinkedHashMap|TreeMap)\s*<[^,]+,\s*([^>]+)>/i.exec(t);
        if (mapMatch) {
            return mapMatch[1].trim();
        }

        // Collection / List / Set / Optional <T> -> T
        const collMatch = /<([^<>]+)>/i.exec(t);
        if (collMatch) {
            return collMatch[1].trim();
        }

        return t;
    }

    /**
     * Parsea un archivo Java en memoria extrayendo clase, superclase, interfaces, campos, métodos y propiedades EL.
     */
    private parseJavaContent(filePath: string, content: string, lastModified: number): JavaClassInfo {
        // Remover comentarios de bloque y de línea para parsear limpiamente
        const stripped = content
            .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
            .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

        // Declaración de clase: public class MiClase extends BaseClase implements Interface1, Interface2
        const classMatch = /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([\w.]+)(?:<[^>]+>)?)?(?:\s+implements\s+([^{]+))?/.exec(stripped);
        const className = classMatch ? classMatch[1] : path.basename(filePath, '.java');
        const superClass = classMatch && classMatch[2] ? classMatch[2].split('.').pop() : undefined;
        const interfaces: string[] = [];
        if (classMatch && classMatch[3]) {
            classMatch[3].split(',').forEach((iface) => {
                const clean = iface.trim().replace(/<[^>]+>/g, '').split('.').pop();
                if (clean) {
                    interfaces.push(clean);
                }
            });
        }

        const hasLombokClassGetter = /@(Getter|Data)\b/.test(stripped);
        const hasLombokClassSetter = /@(Setter|Data)\b/.test(stripped);

        const fields = new Map<string, JavaField>();
        const methods = new Map<string, JavaMethod[]>();
        const properties = new Map<string, ElProperty>();

        // Regex para campos: visibilidad + tipo + nombre [= valor];
        const reField = /^\s*((?:@\w+(?:\([^)]*\))?\s*)*)(?:private|protected|public)\s+(?!static\s|final\s+static\s|class\s|enum\s)([A-Za-z0-9_<>\[\],\s.]+?)\s+(\w+)\s*(?:=[^;]*)?;/gm;
        let fMatch: RegExpExecArray | null;
        while ((fMatch = reField.exec(stripped)) !== null) {
            const annotations = fMatch[1] || '';
            const rawType = fMatch[2].trim();
            const name = fMatch[3];
            const isPublic = fMatch[0].includes('public ');
            const hasLombokFieldGetter = hasLombokClassGetter || /@Getter\b/.test(annotations);
            const hasLombokFieldSetter = hasLombokClassSetter || /@Setter\b/.test(annotations);

            const fieldObj: JavaField = { name, type: rawType, isPublic };
            fields.set(name, fieldObj);

            if (isPublic || hasLombokFieldGetter) {
                properties.set(name, {
                    name,
                    type: rawType,
                    readable: true,
                    writable: isPublic || hasLombokFieldSetter,
                    source: isPublic ? 'field' : 'lombok',
                    field: fieldObj,
                    originClass: className
                });
            }
        }

        // Regex para métodos: visibilidad + tipo + nombre(params) {
        const reMethod = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(public|protected|private)\s+(?!static\s+(?:void\s+main|class)|new\b)([A-Za-z0-9_<>\[\],\s.]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/gm;
        let mMatch: RegExpExecArray | null;
        while ((mMatch = reMethod.exec(stripped)) !== null) {
            const visibility = mMatch[1];
            const returnType = mMatch[2].trim();
            const name = mMatch[3];
            const paramsRaw = mMatch[4].trim();

            if (name === className) {
                // Constructor, ignorar
                continue;
            }

            const params: JavaParam[] = [];
            if (paramsRaw) {
                paramsRaw.split(',').forEach((p) => {
                    const parts = p.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        params.push({
                            type: parts.slice(0, -1).join(' '),
                            name: parts[parts.length - 1]
                        });
                    }
                });
            }

            const isGetter = params.length === 0 && (name.startsWith('get') && name.length > 3);
            const isBooleanGetter = params.length === 0 && (name.startsWith('is') && name.length > 2) && (returnType === 'boolean' || returnType === 'Boolean');
            const isSetter = params.length === 1 && (name.startsWith('set') && name.length > 3);

            const sig = `${visibility} ${returnType} ${name}(${paramsRaw})`;
            const methodObj: JavaMethod = {
                name,
                returnType,
                params,
                signature: sig,
                isGetter,
                isSetter,
                isBooleanGetter
            };

            const existing = methods.get(name) || [];
            existing.push(methodObj);
            methods.set(name, existing);

            // Derivar propiedad EL según la convención JavaBeans
            if (visibility === 'public') {
                if (isGetter || isBooleanGetter) {
                    const prefixLen = isBooleanGetter ? 2 : 3;
                    const propName = name.charAt(prefixLen).toLowerCase() + name.slice(prefixLen + 1);
                    const prevProp = properties.get(propName);
                    properties.set(propName, {
                        name: propName,
                        type: returnType,
                        readable: true,
                        writable: prevProp ? prevProp.writable : false,
                        source: 'getter',
                        getter: methodObj,
                        setter: prevProp?.setter,
                        field: prevProp?.field,
                        originClass: className
                    });
                } else if (isSetter) {
                    const propName = name.charAt(3).toLowerCase() + name.slice(4);
                    const prevProp = properties.get(propName);
                    properties.set(propName, {
                        name: propName,
                        type: prevProp ? prevProp.type : params[0].type,
                        readable: prevProp ? prevProp.readable : false,
                        writable: true,
                        source: prevProp ? prevProp.source : 'getter',
                        getter: prevProp?.getter,
                        setter: methodObj,
                        field: prevProp?.field,
                        originClass: className
                    });
                }
            }
        }

        return {
            className,
            filePath,
            superClass,
            interfaces,
            fields,
            methods,
            properties,
            lastModified
        };
    }
}

