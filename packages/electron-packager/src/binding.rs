use napi::{bindgen_prelude::AsyncTask, Env, Error, Result, Task};
use napi_derive::napi;
use std::path::Path;

#[napi(object)]
pub struct PackOptions {
    pub input: String,
    pub output: String,
    pub unpack: Option<Vec<String>>,
}

pub struct PackTask(PackOptions);

impl Task for PackTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        super::pack(
            Path::new(&self.0.input),
            Path::new(&self.0.output),
            self.0.unpack.as_deref().unwrap_or(&[]),
        )
        .map_err(|error| Error::from_reason(format!("pack failed: {error:#}")))
    }

    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

#[napi]
pub fn pack(options: PackOptions) -> AsyncTask<PackTask> {
    AsyncTask::new(PackTask(options))
}
