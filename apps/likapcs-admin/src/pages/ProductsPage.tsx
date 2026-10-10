/**
 * Products & inventory: catalogue list with search/category/low-stock filters, product editor
 * (barcodes, opening stock), stock adjustments / counts and the per-product movement ledger.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Barcode,
  Boxes,
  History,
  Image as ImageIcon,
  Package,
  Pencil,
  Plus,
  Tag,
  Trash2,
} from 'lucide-react';
import {
  PERMISSIONS,
  STOCK_ADJUSTMENT_TYPES,
  parseMoneyInput,
  type CategorySummary,
  type InventoryMovementSummary,
  type ProductBarcodeInput,
  type ProductSummary,
  type StockAdjustmentType,
  type TaxCategorySummary,
} from '@likapcs/shared';
import { api, apiUpload, ApiError, fieldError } from '../lib/api';
import {
  ProductImageField,
  ProductThumb,
  type PendingImage,
} from '../components/catalog/ProductImageField';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Segmented,
  Select,
  Switch,
  Textarea,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;
const qty = (milli: number) =>
  milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3);
const toMilli = (text: string): number | null => {
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

export function ProductsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PRODUCTS_MANAGE);
  const canAdjust = can(PERMISSIONS.INVENTORY_ADJUST);

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProductSummary | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<ProductSummary | null>(null);
  const [movementsFor, setMovementsFor] = useState<ProductSummary | null>(null);
  const [deleting, setDeleting] = useState<ProductSummary | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => setPage(1), [debouncedQ, categoryId, lowStock, showArchived]);

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api<CategorySummary[]>('/catalog/categories'),
  });
  const products = useQuery({
    queryKey: ['products', 'list', { debouncedQ, categoryId, lowStock, showArchived, page }],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number; page: number; pageSize: number }>('/products', {
        query: {
          q: debouncedQ || undefined,
          categoryId: categoryId || undefined,
          lowStock: lowStock || undefined,
          active: showArchived ? 'all' : 'active',
          page,
          pageSize: PAGE_SIZE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const lowCount = useQuery({
    queryKey: ['products', 'low-count'],
    queryFn: () =>
      api<{ total: number }>('/products', {
        query: { lowStock: true, active: 'active', pageSize: 1 },
      }),
    staleTime: 30_000,
  });
  const allCount = useQuery({
    queryKey: ['products', 'all-count'],
    queryFn: () =>
      api<{ total: number }>('/products', { query: { active: 'active', pageSize: 1 } }),
    staleTime: 30_000,
  });

  return (
    <>
      <PageHeader
        title={t('products.title')}
        subtitle={t('products.subtitle', {
          total: allCount.data?.total ?? '…',
          low: lowCount.data?.total ?? '…',
        })}
        actions={
          <>
            {canManage && (
              <Button onClick={() => setCategoriesOpen(true)}>
                <Tag size={14} /> {t('products.manageCategories')}
              </Button>
            )}
            {canManage && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={14} /> {t('products.add')}
              </Button>
            )}
          </>
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('products.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 320 }}
          aria-label={t('products.search')}
        />
        <Select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label={t('products.category')}
        >
          <option value="">{t('products.allCategories')}</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.productCount})
            </option>
          ))}
        </Select>
        <Switch checked={lowStock} onChange={setLowStock} label={t('products.lowStockOnly')} />
        <Switch
          checked={showArchived}
          onChange={setShowArchived}
          label={t('products.showArchived')}
        />
      </div>

      {products.isLoading && <Loading />}
      {products.isError && <p className="text-danger">{t('common.errorGeneric')}</p>}
      {products.isSuccess && products.data.items.length === 0 && (
        <EmptyState
          icon={<Package size={22} />}
          title={debouncedQ || categoryId || lowStock ? t('common.noResults') : t('products.empty')}
          hint={debouncedQ || categoryId || lowStock ? undefined : t('products.emptyHint')}
          action={
            canManage && !debouncedQ ? (
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={14} /> {t('products.add')}
              </Button>
            ) : undefined
          }
        />
      )}
      {products.isSuccess && products.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('products.name')}</th>
                <th>{t('products.sku')}</th>
                <th>{t('products.category')}</th>
                <th className="right">{t('products.price')}</th>
                <th className="right">{t('products.cost')}</th>
                <th className="right">{t('products.stock')}</th>
                <th className="right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {products.data.items.map((p) => (
                <tr key={p.id} className={p.isActive ? '' : 'row--muted'}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <ProductThumb url={p.imageUrl} name={p.name} />
                      <div>
                        <div className="row" style={{ gap: 8 }}>
                          <strong>{p.name}</strong>
                          {!p.isActive && <Badge>{t('products.archived')}</Badge>}
                          {p.isActive && p.lowStock && (
                            <Badge tone="warning">{t('products.lowBadge')}</Badge>
                          )}
                        </div>
                        {p.barcodes.length > 0 && (
                          <div className="faint" style={{ fontSize: 12 }}>
                            <Barcode size={11} style={{ verticalAlign: '-1px' }} />{' '}
                            {p.barcodes.map((b) => b.barcode).join(', ')}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="mono">{p.sku}</td>
                  <td>
                    {p.categoryName ? (
                      <span className="row" style={{ gap: 6 }}>
                        {p.categoryColor && (
                          <span className="dot" style={{ background: p.categoryColor }} />
                        )}
                        {p.categoryName}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="right num">{fmt.money(p.sellingPriceCents)}</td>
                  <td className="right num faint">
                    {fmt.money(p.averageCostCents || p.purchaseCostCents)}
                  </td>
                  <td className="right num">
                    {p.trackStock ? (
                      <span
                        className={
                          p.stockMilli <= 0 ? 'text-danger' : p.lowStock ? 'text-warning' : ''
                        }
                      >
                        {qty(p.stockMilli)} {p.unitCode}
                      </span>
                    ) : (
                      <span className="faint">∞</span>
                    )}
                  </td>
                  <td className="right">
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon
                        onClick={() => setMovementsFor(p)}
                        aria-label={t('products.movements')}
                        title={t('products.movements')}
                      >
                        <History size={14} />
                      </Button>
                      {canAdjust && p.trackStock && p.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          onClick={() => setAdjusting(p)}
                          aria-label={t('products.adjustStock')}
                          title={t('products.adjustStock')}
                        >
                          <Boxes size={14} />
                        </Button>
                      )}
                      {canManage && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          onClick={() => setEditing(p)}
                          aria-label={t('common.edit')}
                          title={t('common.edit')}
                        >
                          <Pencil size={14} />
                        </Button>
                      )}
                      {canManage && p.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          onClick={() => setDeleting(p)}
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                        >
                          <Archive size={14} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={products.data.total}
            onPage={setPage}
          />
        </div>
      )}

      {editing && (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          categories={categories.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {adjusting && <StockAdjustDialog product={adjusting} onClose={() => setAdjusting(null)} />}
      {movementsFor && (
        <MovementsDialog product={movementsFor} onClose={() => setMovementsFor(null)} />
      )}
      {deleting && <DeleteProductDialog product={deleting} onClose={() => setDeleting(null)} />}
      {categoriesOpen && (
        <CategoriesDialog
          categories={categories.data ?? []}
          onClose={() => setCategoriesOpen(false)}
        />
      )}
    </>
  );
}

// ─── Product create / edit ─────────────────────────────────────────────────────
interface ProductForm {
  name: string;
  sku: string;
  categoryId: string;
  brand: string;
  taxCategoryId: string;
  unitCode: string;
  price: string;
  cost: string;
  priceIncludesTax: boolean;
  minStock: string;
  trackStock: boolean;
  allowNegativeStock: boolean;
  description: string;
  storageLocation: string;
  isActive: boolean;
  initialStock: string;
}
function formFrom(p: ProductSummary | null): ProductForm {
  return {
    name: p?.name ?? '',
    sku: p?.sku ?? '',
    categoryId: p?.categoryId ?? '',
    brand: p?.brand ?? '',
    taxCategoryId: p?.taxCategoryId ?? '',
    unitCode: p?.unitCode ?? 'pc',
    price: p ? (p.sellingPriceCents / 100).toFixed(2) : '',
    cost: p ? (p.purchaseCostCents / 100).toFixed(2) : '',
    priceIncludesTax: p?.priceIncludesTax ?? true,
    minStock: p ? qty(p.minStockMilli) : '0',
    trackStock: p?.trackStock ?? true,
    allowNegativeStock: p?.allowNegativeStock ?? false,
    description: p?.description ?? '',
    storageLocation: p?.storageLocation ?? '',
    isActive: p?.isActive ?? true,
    initialStock: '',
  };
}

class ImageSaveError extends Error {
  constructor(
    readonly product: ProductSummary,
    override readonly cause: unknown,
  ) {
    super('image_save_failed');
  }
}

function ProductDialog({
  product,
  categories,
  onClose,
}: {
  product: ProductSummary | null;
  categories: CategorySummary[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProductForm>(() => formFrom(product));
  const [barcodes, setBarcodes] = useState<ProductBarcodeInput[]>(
    product?.barcodes.map((b) => ({
      barcode: b.barcode,
      quantityMilli: b.quantityMilli,
      isPrimary: b.isPrimary,
    })) ?? [],
  );
  const [newBarcode, setNewBarcode] = useState('');
  const [newPack, setNewPack] = useState('1');
  const [error, setError] = useState<unknown>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage>(null);
  const set = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /** Applies the picture choice after the product row exists (create) or was updated (edit). */
  const applyImage = async (productId: string): Promise<void> => {
    if (!pendingImage) return;
    if (pendingImage.kind === 'upload') {
      await apiUpload<ProductSummary>(
        `/products/${productId}/image`,
        pendingImage.blob,
        {},
        {
          method: 'PUT',
          contentType: pendingImage.contentType,
        },
      );
    } else if (pendingImage.kind === 'link') {
      await api<ProductSummary>(`/products/${productId}/image/from-url`, {
        method: 'POST',
        body: { url: pendingImage.url },
      });
    } else {
      await api<ProductSummary>(`/products/${productId}/image`, { method: 'DELETE' });
    }
  };

  const taxCategories = useQuery({
    queryKey: ['catalog', 'tax-categories'],
    queryFn: () => api<TaxCategorySummary[]>('/catalog/tax-categories'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };
  const priceCents = parseMoneyInput(form.price);
  const costCents = form.cost.trim() ? parseMoneyInput(form.cost) : 0;
  const minStockMilli = toMilli(form.minStock || '0');
  const initialStockMilli = form.initialStock.trim() ? toMilli(form.initialStock) : null;

  const save = useMutation({
    mutationFn: async () => {
      if (priceCents === null || costCents === null || minStockMilli === null)
        throw new Error('invalid');
      const base = {
        name: form.name.trim(),
        categoryId: form.categoryId || null,
        brand: form.brand.trim() || null,
        taxCategoryId: form.taxCategoryId || null,
        unitCode: form.unitCode.trim() || 'pc',
        purchaseCostCents: costCents,
        sellingPriceCents: priceCents,
        priceIncludesTax: form.priceIncludesTax,
        minStockMilli,
        allowNegativeStock: form.allowNegativeStock,
        trackStock: form.trackStock,
        description: form.description.trim() || null,
        storageLocation: form.storageLocation.trim() || null,
        isActive: form.isActive,
      };
      let saved: ProductSummary;
      if (product) {
        saved = await api<ProductSummary>(`/products/${product.id}`, {
          method: 'PATCH',
          body: { ...base, sku: form.sku.trim() || undefined },
        });
      } else {
        saved = await api<ProductSummary>('/products', {
          method: 'POST',
          body: {
            ...base,
            sku: form.sku.trim() || undefined,
            barcodes,
            initialStockMilli:
              initialStockMilli && initialStockMilli > 0 ? initialStockMilli : undefined,
          },
        });
      }
      try {
        await applyImage(saved.id);
      } catch (err) {
        // The product itself is saved; only the picture failed — say so and keep the dialog open
        // on the (now existing) product so the user can retry.
        throw new ImageSaveError(saved, err);
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(t('products.saved'));
      invalidate();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ImageSaveError) {
        invalidate();
        toast.error(err.cause instanceof ApiError ? err.cause.message : t('products.imageInvalid'));
        return;
      }
      setError(err);
      if (!(err instanceof ApiError && err.status === 400))
        toast.error(err instanceof ApiError ? err.message : t('common.invalid'));
    },
  });
  const addBarcode = useMutation({
    mutationFn: (input: ProductBarcodeInput) =>
      api<ProductSummary>(`/products/${product!.id}/barcodes`, { method: 'POST', body: input }),
    onSuccess: (p) => {
      setBarcodes(
        p.barcodes.map((b) => ({
          barcode: b.barcode,
          quantityMilli: b.quantityMilli,
          isPrimary: b.isPrimary,
        })),
      );
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const removeBarcode = useMutation({
    mutationFn: (barcodeId: string) =>
      api<void>(`/products/${product!.id}/barcodes/${barcodeId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  // Barcode rows for an existing product carry server ids (needed for deletion).
  const existing = useQuery({
    queryKey: ['products', 'detail', product?.id],
    queryFn: () => api<ProductSummary>(`/products/${product!.id}`),
    enabled: !!product,
  });
  const existingBarcodes = existing.data?.barcodes ?? product?.barcodes ?? [];

  const onAddBarcode = () => {
    const code = newBarcode.trim();
    const packMilli = toMilli(newPack || '1');
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(code) || !packMilli || packMilli < 1) {
      toast.error(t('common.invalid'));
      return;
    }
    const input: ProductBarcodeInput = {
      barcode: code,
      quantityMilli: packMilli,
      isPrimary: barcodes.length === 0,
    };
    if (product) addBarcode.mutate(input);
    else setBarcodes((b) => [...b, input]);
    setNewBarcode('');
    setNewPack('1');
  };

  const fe = (field: string) => fieldError(error, field);
  const valid =
    form.name.trim().length > 0 &&
    priceCents !== null &&
    costCents !== null &&
    minStockMilli !== null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={product ? t('products.edit') : t('products.add')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <div className="grid grid--2">
          <Field label={t('products.name')} error={fe('name')}>
            {(id, invalid) => (
              <Input
                id={id}
                value={form.name}
                autoFocus
                maxLength={120}
                aria-invalid={invalid}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('products.sku')}
            hint={product ? undefined : t('products.skuHint')}
            error={fe('sku')}
            optional
          >
            {(id, invalid) => (
              <Input
                id={id}
                value={form.sku}
                maxLength={40}
                className="mono"
                aria-invalid={invalid}
                onChange={(e) => set('sku', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('products.category')} optional>
            {(id) => (
              <Select
                id={id}
                value={form.categoryId}
                onChange={(e) => set('categoryId', e.target.value)}
              >
                <option value="">{t('common.none')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('products.brand')} optional>
            {(id) => (
              <Input
                id={id}
                value={form.brand}
                maxLength={80}
                onChange={(e) => set('brand', e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('products.price')}
            error={
              fe('sellingPriceCents') ??
              (form.price && priceCents === null ? t('common.invalid') : undefined)
            }
          >
            {(id, invalid) => (
              <Input
                id={id}
                value={form.price}
                inputMode="decimal"
                className="num"
                aria-invalid={invalid}
                onChange={(e) => set('price', e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('products.cost')}
            error={form.cost && costCents === null ? t('common.invalid') : undefined}
            optional
          >
            {(id, invalid) => (
              <Input
                id={id}
                value={form.cost}
                inputMode="decimal"
                className="num"
                aria-invalid={invalid}
                onChange={(e) => set('cost', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('products.taxCategory')} optional>
            {(id) => (
              <Select
                id={id}
                value={form.taxCategoryId}
                onChange={(e) => set('taxCategoryId', e.target.value)}
              >
                <option value="">
                  {(() => {
                    const def = (taxCategories.data ?? []).find((c) => c.isDefault);
                    return t('products.defaultTax', {
                      rate: def ? `${(def.rateBp / 100).toFixed(def.rateBp % 100 ? 2 : 0)}%` : '—',
                    });
                  })()}
                </option>
                {(taxCategories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({(c.rateBp / 100).toFixed(c.rateBp % 100 ? 2 : 0)}%)
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('products.unit')}>
            {(id) => (
              <Input
                id={id}
                value={form.unitCode}
                maxLength={16}
                onChange={(e) => set('unitCode', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Switch
          checked={form.priceIncludesTax}
          onChange={(v) => set('priceIncludesTax', v)}
          label={t('products.priceIncludesTax')}
        />
        <div className="grid grid--2">
          <Switch
            checked={form.trackStock}
            onChange={(v) => set('trackStock', v)}
            label={t('products.trackStock')}
          />
          <Switch
            checked={form.allowNegativeStock}
            onChange={(v) => set('allowNegativeStock', v)}
            label={t('products.allowNegative')}
            disabled={!form.trackStock}
          />
          <Field label={t('products.minStock')}>
            {(id) => (
              <Input
                id={id}
                value={form.minStock}
                inputMode="decimal"
                className="num"
                onChange={(e) => set('minStock', e.target.value)}
                disabled={!form.trackStock}
              />
            )}
          </Field>
          {!product && (
            <Field label={t('products.initialStock')} optional>
              {(id) => (
                <Input
                  id={id}
                  value={form.initialStock}
                  inputMode="decimal"
                  className="num"
                  onChange={(e) => set('initialStock', e.target.value)}
                  disabled={!form.trackStock}
                />
              )}
            </Field>
          )}
          <Field label={t('products.location')} optional>
            {(id) => (
              <Input
                id={id}
                value={form.storageLocation}
                maxLength={80}
                onChange={(e) => set('storageLocation', e.target.value)}
              />
            )}
          </Field>
          {product && (
            <Switch
              checked={form.isActive}
              onChange={(v) => set('isActive', v)}
              label={t('products.active')}
            />
          )}
        </div>
        <Field label={t('products.description')} optional>
          {(id) => (
            <Textarea
              id={id}
              value={form.description}
              rows={2}
              maxLength={1000}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>

        <div className="subhead">
          <ImageIcon size={14} /> {t('products.image')}
        </div>
        <ProductImageField
          currentUrl={existing.data?.imageUrl ?? product?.imageUrl ?? null}
          pending={pendingImage}
          onChange={setPendingImage}
          disabled={save.isPending}
        />

        <div className="subhead">
          <Barcode size={14} /> {t('products.barcodes')}
        </div>
        {product
          ? existingBarcodes.length === 0 && <p className="faint">{t('products.noBarcodes')}</p>
          : barcodes.length === 0 && <p className="faint">{t('products.noBarcodes')}</p>}
        <div className="chips">
          {product
            ? existingBarcodes.map((b) => (
                <span key={b.id ?? b.barcode} className="chip chip--static">
                  <span className="mono">{b.barcode}</span>
                  {b.quantityMilli !== 1000 && (
                    <span className="faint"> ×{qty(b.quantityMilli)}</span>
                  )}
                  {b.id && (
                    <button
                      type="button"
                      className="chip__x"
                      onClick={() => removeBarcode.mutate(b.id!)}
                      aria-label={t('common.delete')}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))
            : barcodes.map((b, i) => (
                <span key={b.barcode} className="chip chip--static">
                  <span className="mono">{b.barcode}</span>
                  {b.quantityMilli !== 1000 && (
                    <span className="faint"> ×{qty(b.quantityMilli)}</span>
                  )}
                  <button
                    type="button"
                    className="chip__x"
                    onClick={() => setBarcodes((list) => list.filter((_, j) => j !== i))}
                    aria-label={t('common.delete')}
                  >
                    ×
                  </button>
                </span>
              ))}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label={t('products.barcode')} className="grow">
            {(id) => (
              <Input
                id={id}
                value={newBarcode}
                className="mono"
                maxLength={64}
                placeholder="5901234123457"
                onChange={(e) => setNewBarcode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onAddBarcode();
                  }
                }}
              />
            )}
          </Field>
          <Field label={t('products.packQty')} className="w-24">
            {(id) => (
              <Input
                id={id}
                value={newPack}
                inputMode="decimal"
                className="num"
                onChange={(e) => setNewPack(e.target.value)}
              />
            )}
          </Field>
          <Button
            onClick={onAddBarcode}
            loading={addBarcode.isPending}
            disabled={!newBarcode.trim()}
          >
            <Plus size={14} /> {t('products.addBarcode')}
          </Button>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ─── Stock adjustment ──────────────────────────────────────────────────────────
function StockAdjustDialog({ product, onClose }: { product: ProductSummary; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'delta' | 'count'>('delta');
  const [type, setType] = useState<StockAdjustmentType>('adjustment');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState('');

  const amountMilli = toMilli(amount);
  const costCents = cost.trim() ? parseMoneyInput(cost) : null;
  const projected =
    mode === 'count' ? amountMilli : amountMilli === null ? null : product.stockMilli + amountMilli;
  const amountOk =
    amountMilli !== null && (mode === 'delta' ? amountMilli !== 0 : amountMilli >= 0);
  const costOk = !cost.trim() || costCents !== null;
  const valid = amountOk && costOk && reason.trim().length >= 2;

  const adjust = useMutation({
    mutationFn: () =>
      api<ProductSummary>(`/products/${product.id}/stock`, {
        method: 'POST',
        body: {
          type: mode === 'count' ? 'stock_count' : type,
          ...(mode === 'count'
            ? { newStockMilli: amountMilli }
            : { quantityMilliDelta: amountMilli }),
          reason: reason.trim(),
          unitCostCents: costCents ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success(t('products.adjusted'));
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('products.adjustTitle', { name: product.name })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={adjust.isPending}
            onClick={() => adjust.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row--between">
          <span className="muted">{t('products.stock')}</span>
          <strong className="num">
            {qty(product.stockMilli)} {product.unitCode}
          </strong>
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'delta', label: t('products.byDelta') },
            { value: 'count', label: t('products.byCount') },
          ]}
        />
        {mode === 'delta' && (
          <Field label={t('products.adjustType')}>
            {(id) => (
              <Select
                id={id}
                value={type}
                onChange={(e) => setType(e.target.value as StockAdjustmentType)}
              >
                {STOCK_ADJUSTMENT_TYPES.filter((x) => x !== 'stock_count').map((x) => (
                  <option key={x} value={x}>
                    {t(`products.movementTypes.${x}` as 'products.movementTypes.adjustment')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          label={mode === 'delta' ? t('products.delta') : t('products.counted')}
          hint={mode === 'delta' ? '+ / −' : undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={amount}
              autoFocus
              inputMode="decimal"
              className="num"
              placeholder={mode === 'delta' ? '-1' : '0'}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        {mode === 'delta' && amountMilli !== null && amountMilli > 0 && (
          <Field label={t('products.cost')} optional>
            {(id) => (
              <Input
                id={id}
                value={cost}
                inputMode="decimal"
                className="num"
                onChange={(e) => setCost(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label={t('products.reason')}>
          {(id) => (
            <Input
              id={id}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        {projected !== null && (
          <div className="row row--between">
            <span className="muted">→ {t('products.stock')}</span>
            <strong className={`num ${projected < 0 ? 'text-danger' : ''}`}>
              {qty(projected)} {product.unitCode}
            </strong>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─── Movement ledger ───────────────────────────────────────────────────────────
function MovementsDialog({ product, onClose }: { product: ProductSummary; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const movements = useQuery({
    queryKey: ['inventory', 'movements', product.id],
    queryFn: () =>
      api<{ items: InventoryMovementSummary[]; total: number }>('/inventory/movements', {
        query: { productId: product.id, pageSize: 200 },
      }),
  });
  return (
    <Dialog open onClose={onClose} title={`${t('products.movements')} — ${product.name}`} size="lg">
      {movements.isLoading && <Loading />}
      {movements.isSuccess && movements.data.items.length === 0 && (
        <p className="muted">{t('products.noMovements')}</p>
      )}
      {movements.isSuccess && movements.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('common.time')}</th>
                <th>{t('common.status')}</th>
                <th className="right">Δ</th>
                <th className="right">{t('products.stock')}</th>
                <th>{t('products.reason')}</th>
                <th>{t('sales.cashier')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.data.items.map((m) => (
                <tr key={m.id}>
                  <td className="num">{fmt.dateTime(m.createdAt)}</td>
                  <td>
                    {t(
                      `products.movementTypes.${m.movementType}` as 'products.movementTypes.adjustment',
                    )}
                  </td>
                  <td
                    className={`right num ${m.quantityMilliDelta < 0 ? 'text-danger' : 'text-success'}`}
                  >
                    {m.quantityMilliDelta > 0 ? '+' : ''}
                    {qty(m.quantityMilliDelta)}
                  </td>
                  <td className="right num">{qty(m.stockAfterMilli)}</td>
                  <td className="faint">
                    {m.reason ?? (m.referenceType ? `${m.referenceType}` : '')}
                  </td>
                  <td className="faint">{m.createdByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

// ─── Delete / archive ──────────────────────────────────────────────────────────
function DeleteProductDialog({
  product,
  onClose,
}: {
  product: ProductSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api<{ archived: boolean }>(`/products/${product.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      toast.success(r.archived ? t('products.archivedDone') : t('products.deleted'));
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => remove.mutate()}
      title={`${t('products.deleteTitle')} — ${product.name}`}
      body={t('products.deleteBody')}
      confirmLabel={t('common.delete')}
      danger
      loading={remove.isPending}
    />
  );
}

// ─── Categories ────────────────────────────────────────────────────────────────
function CategoriesDialog({
  categories,
  onClose,
}: {
  categories: CategorySummary[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CategorySummary | null>(null);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };
  const sorted = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [categories],
  );

  const save = useMutation({
    mutationFn: () =>
      editId
        ? api<CategorySummary>(`/catalog/categories/${editId}`, {
            method: 'PATCH',
            body: { name: name.trim(), color },
          })
        : api<CategorySummary>('/catalog/categories', {
            method: 'POST',
            body: { name: name.trim(), color },
          }),
    onSuccess: () => {
      invalidate();
      setName('');
      setEditId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/catalog/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog open onClose={onClose} title={t('products.categories')} size="sm">
      <div className="stack">
        <form
          className="row"
          style={{ gap: 8, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Field label={editId ? t('common.edit') : t('products.newCategory')} className="grow">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('products.color')}>
            {(id) => (
              <input
                id={id}
                type="color"
                className="input input--color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={!name.trim()} loading={save.isPending}>
            {editId ? t('common.save') : t('common.add')}
          </Button>
          {editId && (
            <Button
              onClick={() => {
                setEditId(null);
                setName('');
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
        </form>
        {sorted.length === 0 && <p className="faint">{t('common.none')}</p>}
        {sorted.map((c) => (
          <div
            key={c.id}
            className="row row--between"
            style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}
          >
            <span className="row" style={{ gap: 8 }}>
              <span className="dot" style={{ background: c.color ?? 'var(--border-strong)' }} />
              {c.name}
              <span className="faint">
                · {c.productCount} {t('products.products').toLowerCase()}
              </span>
            </span>
            <span className="row" style={{ gap: 4 }}>
              <Button
                size="sm"
                variant="ghost"
                icon
                aria-label={t('common.edit')}
                onClick={() => {
                  setEditId(c.id);
                  setName(c.name);
                  setColor(c.color ?? '#6366f1');
                }}
              >
                <Pencil size={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon
                aria-label={t('common.delete')}
                onClick={() => setDeleteTarget(c)}
              >
                <Trash2 size={14} />
              </Button>
            </span>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        title={deleteTarget?.name ?? ''}
        body={t('products.deleteCategoryBody')}
        confirmLabel={t('common.delete')}
        danger
        loading={remove.isPending}
      />
    </Dialog>
  );
}
