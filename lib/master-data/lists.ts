/** Definition of every editable dropdown list. The table name is whitelisted here, never taken from input. */
export type FieldDef = { key: string; label: string; required?: boolean; placeholder?: string };
export type ListDef = {
  slug: string;
  table: string;
  title: string;
  description: string;
  fields: FieldDef[];
  /** Column used for ordering and duplicate hints. */
  orderBy: string;
};

export const LISTS: ListDef[] = [
  { slug: "vendors", table: "md_vendors", title: "Vendor Name", description: "Daftar vendor untuk kolom Vendor Name.", fields: [{ key: "name", label: "Nama vendor", required: true }], orderBy: "name" },
  { slug: "payment-types", table: "md_payment_types", title: "Payment Type", description: "Monthly, Quaterly, dst.", fields: [{ key: "name", label: "Payment Type", required: true }], orderBy: "name" },
  { slug: "cashflow-categories", table: "md_cashflow_categories", title: "Cashflow Category", description: "Kategori arus kas.", fields: [{ key: "name", label: "Cashflow Category", required: true }], orderBy: "name" },
  { slug: "divisions", table: "md_divisions", title: "Division → Department", description: "Division menentukan Department.", fields: [{ key: "division", label: "Division", required: true }, { key: "department", label: "Department", required: true }], orderBy: "division" },
  { slug: "tax-categories", table: "md_tax_categories", title: "Tax Category", description: "Pajak yang berlaku ditentukan dari nama kategori (mis. \"PPN + PPh 23\"). Ubah nama dengan hati-hati.", fields: [{ key: "name", label: "Tax Category", required: true }], orderBy: "name" },
  { slug: "accounts", table: "md_accounts", title: "Accounting Account", description: "Nomor dan nama akun.", fields: [{ key: "code", label: "Nomor akun", required: true }, { key: "name", label: "Nama akun", required: true }], orderBy: "code" },
  { slug: "currencies", table: "md_currencies", title: "Currency", description: "Kode mata uang 3 huruf besar.", fields: [{ key: "code", label: "Kode", required: true, placeholder: "IDR" }], orderBy: "code" },
];

export const getList = (slug: string) => LISTS.find((l) => l.slug === slug);
