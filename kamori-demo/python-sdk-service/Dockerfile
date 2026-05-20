FROM python:3.12-slim
WORKDIR /project
COPY sdks/python ./sdks/python
COPY kamori-demo/python-sdk-service ./kamori-demo/python-sdk-service
WORKDIR /project/kamori-demo/python-sdk-service
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt \
 && pip install /project/sdks/python
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5002"]
