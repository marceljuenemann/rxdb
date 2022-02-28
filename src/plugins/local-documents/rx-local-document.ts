import objectPath from 'object-path';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { overwritable } from '../../overwritable';
import { basePrototype, createRxDocumentConstructor } from '../../rx-document';
import { newRxError, newRxTypeError } from '../../rx-error';
import { writeSingle } from '../../rx-storage-helper';
import type {
    LocalDocumentState,
    RxChangeEvent,
    RxCollection,
    RxDatabase,
    RxDocument,
    RxDocumentData,
    RxDocumentWriteData,
    RxLocalDocument,
    RxLocalDocumentData
} from '../../types';
import { flatClone, getDefaultRxDocumentMeta, getFromObjectOrThrow } from '../../util';
import { getLocalDocStateByParent } from './local-documents-helper';

const RxDocumentParent = createRxDocumentConstructor() as any;

class RxLocalDocumentClass<DocData = any> extends RxDocumentParent {
    constructor(
        public readonly id: string,
        jsonData: DocData,
        public readonly parent: RxCollection | RxDatabase,
        public readonly state: LocalDocumentState
    ) {
        super(null, jsonData);
    }
}



const RxLocalDocumentPrototype: any = {
    get isLocal() {
        return true;
    },

    //
    // overwrites
    //

    _handleChangeEvent(
        this: any,
        changeEvent: RxChangeEvent<RxLocalDocumentData>
    ) {
        if (changeEvent.documentId !== this.primary) {
            return;
        }
        switch (changeEvent.operation) {
            case 'UPDATE':
                const newData = changeEvent.documentData;
                this._dataSync$.next(newData);
                break;
            case 'DELETE':
                // remove from docCache to assure new upserted RxDocuments will be a new instance
                const docCache = this.state.docCache;
                docCache.delete(this.primary);
                this._isDeleted$.next(true);
                break;
        }
    },

    get allAttachments$() {
        // this is overwritten here because we cannot re-set getters on the prototype
        throw newRxError('LD1', {
            document: this
        });
    },
    get primaryPath() {
        return 'id';
    },
    get primary() {
        return this.id;
    },
    get $() {
        return (this as RxDocument)._dataSync$.asObservable();
    },
    $emit(this: any, changeEvent: RxChangeEvent<RxLocalDocumentData>) {
        return this.parent.$emit(changeEvent);
    },
    get(this: RxDocument, objPath: string) {
        objPath = 'data.' + objPath;

        if (!this._data) {
            return undefined;
        }
        if (typeof objPath !== 'string') {
            throw newRxTypeError('LD2', {
                objPath
            });
        }

        let valueObj = objectPath.get(this._data, objPath);
        valueObj = overwritable.deepFreezeWhenDevMode(valueObj);
        return valueObj;
    },
    get$(this: RxDocument, objPath: string) {
        objPath = 'data.' + objPath;

        if (objPath.includes('.item.')) {
            throw newRxError('LD3', {
                objPath
            });
        }
        if (objPath === this.primaryPath) {
            throw newRxError('LD4');
        }

        return this._dataSync$
            .pipe(
                map(data => objectPath.get(data, objPath)),
                distinctUntilChanged()
            );
    },
    atomicPatch(patch: Partial<any>) {
        return this.atomicUpdate((docData: any) => {
            Object
                .entries(patch)
                .forEach(([k, v]) => {
                    (docData as any).data[k] = v;
                });
            return docData;
        });
    },
    async _saveData(this: RxLocalDocument<any>, newData: RxDocumentData<RxLocalDocumentData>) {
        const state = await getLocalDocStateByParent(this.parent);
        const oldData: RxDocumentData<RxLocalDocumentData> = this._dataSync$.getValue() as any;
        newData.id = (this as any).id;

        return state.storageInstance.bulkWrite([{
            previous: oldData,
            document: newData
        }])
            .then((res) => {
                const docResult = res.success[newData.id];
                if (!docResult) {
                    throw getFromObjectOrThrow(res.error, newData.id);
                }
                newData = flatClone(newData);
                newData._rev = docResult._rev;
            });
    },

    async remove(this: any): Promise<void> {
        const state = await getLocalDocStateByParent(this.parent);
        const writeData: RxDocumentWriteData<RxLocalDocumentData> = {
            id: this.id,
            data: {},
            _deleted: true,
            _meta: getDefaultRxDocumentMeta(),
            _attachments: {}
        };
        return writeSingle(state.storageInstance, {
            previous: this._data,
            document: writeData
        })
            .then(() => {
                this.state.docCache.delete(this.id);
            });
    }
};



let INIT_DONE = false;
const _init = () => {
    if (INIT_DONE) return;
    else INIT_DONE = true;

    // add functions of RxDocument
    const docBaseProto = basePrototype;
    const props = Object.getOwnPropertyNames(docBaseProto);
    props.forEach(key => {
        const exists = Object.getOwnPropertyDescriptor(RxLocalDocumentPrototype, key);
        if (exists) return;
        const desc: any = Object.getOwnPropertyDescriptor(docBaseProto, key);
        Object.defineProperty(RxLocalDocumentPrototype, key, desc);
    });


    /**
     * Overwrite things that do not work on local documents
     * with a throwing function.
     */
    const getThrowingFun = (k: string) => () => {
        throw newRxError('LD6', {
            functionName: k
        });
    };
    [
        'populate',
        'update',
        'putAttachment',
        'getAttachment',
        'allAttachments'
    ].forEach((k: string) => RxLocalDocumentPrototype[k] = getThrowingFun(k));
};



export function createRxLocalDocument<DocData>(
    id: string,
    data: RxDocumentData<RxLocalDocumentData<DocData>>,
    parent: any,
    state: LocalDocumentState
): RxLocalDocument<DocData> {
    _init();
    const newDoc = new RxLocalDocumentClass(id, data, parent, state);
    newDoc.__proto__ = RxLocalDocumentPrototype;
    state.docCache.set(id, newDoc as any);
    return newDoc as any;
}